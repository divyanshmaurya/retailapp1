#!/usr/bin/env python3
"""
Stage 1 of the data pipeline: read the SAP Customer Checkout "Complete Sales
Report" workbooks exported from the S.Mart Walldorf store and turn them into a
small set of canonical, tidy CSV files under ``data/canonical``.

The workbooks are report exports, not tables: every sheet carries five or six
lines of run metadata before the real header, group sheets repeat a parent key
only on its first row, and a trailing "Total" row is mixed in with the data.
This module deals with all three so that stage 2 (synthesize_dataset.py) can
work with plain rectangular data.

Usage:
    python3 tools/etl_sap_export.py --source <dir-with-xlsx> [--out data/canonical]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import warnings
from dataclasses import dataclass
from pathlib import Path

warnings.filterwarnings("ignore", module="openpyxl")

try:
    import pandas as pd
    from openpyxl import load_workbook
except ImportError:  # pragma: no cover
    sys.exit("This script needs pandas and openpyxl: pip install pandas openpyxl")


# Lines the report generator puts above the real header on every sheet.
METADATA_PREFIXES = (
    "Created at",
    "Created by",
    "Report period",
    "Report time",
    "Selected POS",
    "Group by",
)

# Sheets that hold a single scalar block rather than a table.
SCALAR_SHEETS = {"Cashing up"}


@dataclass
class ReportMeta:
    """The run metadata SAP writes above the header of every sheet."""

    created_at: str | None = None
    created_by: str | None = None
    period_from: str | None = None
    period_to: str | None = None
    pos_systems: str | None = None


def _clean(value):
    """Normalise a cell: blanks and the literal string 'null' become None."""
    if value is None:
        return None
    text = str(value).strip()
    if text == "" or text.lower() in {"nan", "null", "none"}:
        return None
    return text


def read_sheet(path: Path, sheet: str) -> list[list]:
    workbook = load_workbook(path, read_only=True, data_only=True)
    try:
        rows = [list(row) for row in workbook[sheet].values]
    finally:
        workbook.close()
    return rows


def parse_meta(rows: list[list]) -> ReportMeta:
    meta = ReportMeta()
    for row in rows[:10]:
        first = _clean(row[0]) if row else None
        if not first:
            continue
        if first.startswith("Created at"):
            meta.created_at = first.split(":", 1)[1].strip()
        elif first.startswith("Created by"):
            meta.created_by = first.split(":", 1)[1].strip()
        elif first.startswith("Selected POS"):
            meta.pos_systems = first.split(":", 1)[1].strip()
        elif first.startswith("Report period"):
            body = first.split(":", 1)[1].strip()
            halves = body.split(" to ")
            meta.period_from = halves[0].strip()
            if len(halves) > 1:
                meta.period_to = halves[1].strip()
    return meta


def find_header_row(rows: list[list]) -> int | None:
    """The header is the first non-metadata row carrying three or more labels."""
    for index, row in enumerate(rows):
        filled = [v for v in row if _clean(v) is not None]
        if len(filled) < 3:
            continue
        first = _clean(row[0])
        if first and first.startswith(METADATA_PREFIXES):
            continue
        return index
    return None


def sheet_to_frame(path: Path, sheet: str) -> pd.DataFrame:
    """Return the tabular body of a sheet, minus metadata, blanks and totals."""
    rows = read_sheet(path, sheet)
    header_index = find_header_row(rows)
    if header_index is None:
        return pd.DataFrame()

    header = [
        _clean(cell) or f"column_{position}"
        for position, cell in enumerate(rows[header_index])
    ]
    width = len(header)

    body = []
    for row in rows[header_index + 1:]:
        values = [_clean(cell) for cell in row][:width]
        values += [None] * (width - len(values))
        if any(value is not None for value in values):
            body.append(values)

    return pd.DataFrame(body, columns=header)


def to_number(series: pd.Series) -> pd.Series:
    return pd.to_numeric(series, errors="coerce")


def drop_totals(frame: pd.DataFrame, column: str) -> pd.DataFrame:
    """Remove the trailing aggregate rows SAP appends to each report."""
    if frame.empty or column not in frame.columns:
        return frame
    mask = frame[column].astype(str).str.strip().str.lower() != "total"
    return frame[mask].copy()


def forward_fill_group(frame: pd.DataFrame, column: str) -> pd.DataFrame:
    """Group sheets repeat the parent key only once; carry it down its block."""
    if column in frame.columns:
        frame[column] = frame[column].ffill()
    return frame


# --------------------------------------------------------------------------
# Per-report extractors
# --------------------------------------------------------------------------

def extract_articles(path: Path) -> pd.DataFrame:
    frame = sheet_to_frame(path, "Revenue per article")
    frame = drop_totals(frame, "Article")
    if frame.empty:
        return frame

    numeric = [
        "Number of articles",
        "Gross sales w/o discount",
        "Gross discounts",
        "Gross sales",
        "Net revenue w/o discount",
        "Net discounts",
        "Net revenue",
        "Total VAT",
        "Total due amount",
    ]
    for column in numeric:
        if column in frame.columns:
            frame[column] = to_number(frame[column])

    frame = frame.rename(
        columns={
            "ID": "articleId",
            "Article": "articleName",
            "Number of articles": "quantitySold",
            "Gross sales w/o discount": "grossSalesBeforeDiscount",
            "Gross discounts": "grossDiscount",
            "Gross sales": "grossSales",
            "Net revenue w/o discount": "netRevenueBeforeDiscount",
            "Net discounts": "netDiscount",
            "Net revenue": "netRevenue",
            "Total VAT": "vatAmount",
            "Total due amount": "dueAmount",
        }
    )
    frame = frame[frame["articleId"].notna()].copy()

    # Recover the shelf price and the VAT band actually charged. Articles that
    # never sold in the period carry no revenue, so their price stays unknown
    # here and is filled in from the article-group median during stage 2.
    quantity = frame["quantitySold"].replace(0, float("nan"))
    frame["unitPriceGross"] = (
        frame["grossSalesBeforeDiscount"].astype(float) / quantity.astype(float)
    ).round(4)
    net = frame["netRevenue"].replace(0, float("nan"))
    frame["vatRatePct"] = (
        frame["vatAmount"].astype(float) / net.astype(float) * 100
    ).round(1)

    return frame


def extract_article_groups(path: Path) -> pd.DataFrame:
    frame = sheet_to_frame(path, "Revenue per art. group and art.")
    frame = forward_fill_group(frame, "Article group")
    frame = drop_totals(frame, "Article")
    if frame.empty:
        return frame

    frame = frame.rename(
        columns={
            "ID": "articleId",
            "Article group": "articleGroup",
            "Article": "articleName",
            "Number of articles": "quantitySold",
            "Net revenue": "netRevenue",
        }
    )
    keep = [c for c in ["articleId", "articleGroup", "articleName", "quantitySold", "netRevenue"] if c in frame.columns]
    frame = frame[keep]
    frame = frame[frame["articleId"].notna()].copy()
    for column in ("quantitySold", "netRevenue"):
        if column in frame.columns:
            frame[column] = to_number(frame[column])
    return frame


def extract_hourly_sales(path: Path) -> pd.DataFrame:
    """
    'Revenue per art. and timespan' interleaves an hourly Total row with the
    article lines belonging to that hour. Carry the timespan down each block
    and drop the Total rows, leaving one row per article per hour.
    """
    frame = sheet_to_frame(path, "Revenue per art. and timespan")
    if frame.empty:
        return frame

    frame = forward_fill_group(frame, "Timespan")
    frame = drop_totals(frame, "Article")
    frame = frame.rename(
        columns={
            "Timespan": "timespan",
            "Article": "articleName",
            "Number of articles": "quantity",
            "Net revenue": "netRevenue",
            "Total VAT": "vatAmount",
            "Total due amount": "dueAmount",
        }
    )
    frame = frame[frame["timespan"].notna() & frame["articleName"].notna()].copy()

    # "2026-01-01 20:00 - 2026-01-01 21:00" -> the interval start.
    frame["hourStart"] = pd.to_datetime(
        frame["timespan"].str.slice(0, 16), format="%Y-%m-%d %H:%M", errors="coerce"
    )
    frame = frame[frame["hourStart"].notna()].copy()

    for column in ("quantity", "netRevenue", "vatAmount", "dueAmount"):
        if column in frame.columns:
            frame[column] = to_number(frame[column])

    frame["date"] = frame["hourStart"].dt.date
    frame["hour"] = frame["hourStart"].dt.hour
    frame["dayOfWeek"] = frame["hourStart"].dt.dayofweek
    return frame.drop(columns=["timespan"])


def extract_cancellations(path: Path) -> pd.DataFrame:
    frame = sheet_to_frame(path, "Cancelations")
    frame = forward_fill_group(frame, "POS group/Cashier")
    frame = drop_totals(frame, "Article")
    if frame.empty:
        return frame

    frame = frame.rename(
        columns={
            "Article ID": "articleId",
            "POS group/Cashier": "posGroupCashier",
            "Article": "articleName",
            "Count": "cancellationCount",
            "Quantity": "cancelledQuantity",
            "Absolute amount": "cancelledAmount",
        }
    )
    frame = frame[frame["articleId"].notna()].copy()
    for column in ("cancellationCount", "cancelledQuantity", "cancelledAmount"):
        frame[column] = to_number(frame[column])

    # The sheet mixes both terminals into one column; split out the cashier so
    # autonomous (payfree) cancellations can be told apart from staffed ones.
    frame["cashier"] = (
        frame["posGroupCashier"].astype(str).str.rsplit("/", n=1).str[-1].str.strip()
    )
    return frame


def extract_returns(path: Path) -> pd.DataFrame:
    frame = sheet_to_frame(path, "Returns")
    frame = forward_fill_group(frame, "POS group/Cashier")
    frame = drop_totals(frame, "Article")
    if frame.empty:
        return frame
    frame = frame.rename(
        columns={
            "Article ID": "articleId",
            "Article": "articleName",
            "Count": "returnCount",
            "Quantity": "returnedQuantity",
            "Absolute amount": "returnedAmount",
            "Reason": "reason",
        }
    )
    frame = frame[frame["articleId"].notna()].copy()
    for column in ("returnCount", "returnedQuantity", "returnedAmount"):
        frame[column] = to_number(frame[column])
    return frame


def extract_pos_systems(path: Path) -> pd.DataFrame:
    frame = sheet_to_frame(path, "Revenue per POS system")
    frame = drop_totals(frame, "POS system")
    if frame.empty:
        return frame
    frame = frame.rename(
        columns={
            "ID": "posSystemId",
            "POS system": "posSystemName",
            "Number of receipts": "receiptCount",
            "Gross sales": "grossSales",
            "Net revenue": "netRevenue",
            "Total VAT": "vatAmount",
        }
    )
    for column in ("receiptCount", "grossSales", "netRevenue", "vatAmount"):
        if column in frame.columns:
            frame[column] = to_number(frame[column])
    return frame[frame["posSystemId"].notna()].copy()


def extract_payment_methods(path: Path) -> pd.DataFrame:
    """
    'Rev. payment method and pos' nests POS rows underneath each payment
    method: the method row carries POS system 'Total', the rows below it carry
    the actual terminal. Keep the terminal-level rows and attach the method.
    """
    frame = sheet_to_frame(path, "Rev. payment method and pos")
    if frame.empty:
        return frame

    frame = frame.rename(
        columns={
            "ID": "id",
            "Payment method": "paymentMethod",
            "POS system": "posSystemId",
            "Number of payment items": "itemCount",
            "Amount": "amount",
        }
    )
    frame["paymentMethod"] = frame["paymentMethod"].ffill()
    frame = frame[frame["posSystemId"].notna()].copy()
    frame = frame[frame["posSystemId"].str.lower() != "total"].copy()
    for column in ("itemCount", "amount"):
        frame[column] = to_number(frame[column])
    frame["paymentMethod"] = (
        frame["paymentMethod"].astype(str).str.replace(" null", "", regex=False).str.strip()
    )
    return frame[frame["paymentMethod"].notna()].copy()


def extract_discounts(path: Path) -> pd.DataFrame:
    frame = sheet_to_frame(path, "Discount")
    frame = drop_totals(frame, "Discount type")
    if frame.empty:
        return frame
    frame = frame.rename(
        columns={
            "ID": "discountId",
            "Discount type": "discountType",
            "Quantity": "quantity",
            "Discount (%)": "discountPct",
            "Gross discounts": "grossDiscount",
            "Net discounts": "netDiscount",
            "Gross sales": "grossSales",
        }
    )
    keep = [c for c in ["discountId", "discountType", "quantity", "discountPct", "grossDiscount", "netDiscount", "grossSales"] if c in frame.columns]
    frame = frame[keep].copy()
    for column in keep[2:]:
        frame[column] = to_number(frame[column])
    return frame[frame["discountType"].notna()].copy()


def extract_taxes(path: Path) -> pd.DataFrame:
    frame = sheet_to_frame(path, "Taxes")
    if frame.empty:
        return frame
    frame = frame.rename(
        columns={
            "Region": "region",
            "Tax rate type code": "taxRateType",
            "Tax rate (%)": "taxRatePct",
            "Taxable amount": "taxableAmount",
            "Tax": "taxAmount",
        }
    )
    keep = [c for c in ["region", "taxRateType", "taxRatePct", "taxableAmount", "taxAmount"] if c in frame.columns]
    frame = frame[keep].copy()
    frame = frame[frame["taxRateType"].notna()].copy()
    for column in ("taxRatePct", "taxableAmount", "taxAmount"):
        if column in frame.columns:
            frame[column] = to_number(frame[column])
    return frame


def extract_cashing_up(path: Path) -> dict:
    """The summary sheet is a set of label/value pairs, not a table."""
    rows = read_sheet(path, "Cashing up")
    summary = {}
    for row in rows:
        cells = [_clean(cell) for cell in row]
        for position, cell in enumerate(cells):
            if cell and cell.endswith(":") and position + 1 < len(cells):
                value = cells[position + 1]
                if value is not None:
                    key = cell.rstrip(":").strip()
                    summary[key] = value
    return summary


EXTRACTORS = {
    "articles": extract_articles,
    "article_groups": extract_article_groups,
    "hourly_sales": extract_hourly_sales,
    "cancellations": extract_cancellations,
    "returns": extract_returns,
    "pos_systems": extract_pos_systems,
    "payment_methods": extract_payment_methods,
    "discounts": extract_discounts,
    "taxes": extract_taxes,
}


def discover_workbooks(source: Path) -> list[Path]:
    books = sorted(p for p in source.glob("*.xlsx") if not p.name.startswith("~$"))
    if not books:
        sys.exit(f"No .xlsx workbooks found in {source}")
    return books


def pick_primary(books: list[Path]) -> Path:
    """
    The exports overlap: one covers a single day, the other the whole period.
    Use the workbook with the most hourly rows as the primary source so the
    richer export wins regardless of how the files happen to be named.
    """
    best, best_rows = books[0], -1
    for book in books:
        try:
            rows = len(extract_hourly_sales(book))
        except Exception:
            rows = 0
        if rows > best_rows:
            best, best_rows = book, rows
    return best


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="folder holding the SAP .xlsx exports")
    parser.add_argument("--out", type=Path, default=Path("data/canonical"))
    args = parser.parse_args()

    books = discover_workbooks(args.source)
    primary = pick_primary(books)
    args.out.mkdir(parents=True, exist_ok=True)

    manifest = {
        "workbooks": [b.name for b in books],
        "primary": primary.name,
        "reportMeta": parse_meta(read_sheet(primary, "Revenue per POS system")).__dict__,
        "cashingUp": extract_cashing_up(primary),
        "tables": {},
    }

    print(f"Primary export: {primary.name}")
    for name, extractor in EXTRACTORS.items():
        frame = extractor(primary)
        target = args.out / f"{name}.csv"
        frame.to_csv(target, index=False)
        manifest["tables"][name] = {"rows": len(frame), "columns": list(frame.columns)}
        print(f"  {name:<18} {len(frame):>6} rows -> {target}")

    # The secondary export is the latest single day; keep its hourly rows so the
    # dataset extends to the most recent trading hour available.
    for book in books:
        if book == primary:
            continue
        latest = extract_hourly_sales(book)
        if not latest.empty:
            target = args.out / "hourly_sales_latest.csv"
            latest.to_csv(target, index=False)
            manifest["tables"]["hourly_sales_latest"] = {
                "rows": len(latest),
                "source": book.name,
            }
            print(f"  {'hourly_sales_latest':<18} {len(latest):>6} rows -> {target}")
            break

    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2, default=str))
    print(f"\nManifest written to {args.out / 'manifest.json'}")


if __name__ == "__main__":
    main()
