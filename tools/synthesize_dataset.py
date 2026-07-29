#!/usr/bin/env python3
"""
Stage 2 of the data pipeline: turn the canonical SAP extract into the full
dataset the CAP services read.

The Walldorf store keeps its exported figures unchanged - its hourly sales,
cancellations, returns, payments and article master are the real numbers. The
rest of the network is synthesized from the behaviour observed in that export:
the hour-of-day and day-of-week demand profile, the article mix, the
cancellation rates per terminal type and the payment split are all measured
from the real data and then replayed against stores with different sizes,
opening hours and catchment.

Everything is driven from one seed, so repeated runs produce the same dataset.

Usage:
    python3 tools/synthesize_dataset.py [--canonical data/canonical] [--out db/data]
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import math
import random
import sys
import unicodedata
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

try:
    import pandas as pd
except ImportError:  # pragma: no cover
    sys.exit("This script needs pandas: pip install pandas")

SEED = 20260703
CURRENCY = "EUR"
NAMESPACE = "smart.retail"

# ---------------------------------------------------------------------------
# Reference data used to enrich the German article groups from the export
# ---------------------------------------------------------------------------

# group -> (English name, category, temperature zone, shelf life in days)
# Shelf life 0 marks a non-perishable; it switches off the markdown engine.
GROUP_PROFILE = {
    "Pfand":                ("Deposit Return",        "Deposit",      "AMBIENT", 0),
    "Getränkebehälter":     ("Beverage Containers",   "Deposit",      "AMBIENT", 0),
    "Energydrinks":         ("Energy Drinks",         "Beverages",    "CHILLED", 0),
    "ColaMix Getränke":     ("Cola Mixers",           "Beverages",    "CHILLED", 0),
    "Wasser aromatisiert":  ("Flavoured Water",       "Beverages",    "CHILLED", 0),
    "Wasser":               ("Water",                 "Beverages",    "AMBIENT", 0),
    "Kaltgetränke":         ("Cold Drinks",           "Beverages",    "CHILLED", 0),
    "Eistee":               ("Iced Tea",              "Beverages",    "CHILLED", 0),
    "Smoothie":             ("Smoothies",             "Beverages",    "CHILLED", 12),
    "Milchmischgetränke":   ("Milk Drinks",           "Beverages",    "CHILLED", 14),
    "Bier":                 ("Beer",                  "Alcohol",      "CHILLED", 0),
    "Schaumwein":           ("Sparkling Wine",        "Alcohol",      "AMBIENT", 0),
    "Heissgetränke":        ("Hot Drinks",            "Beverages",    "HOT",     0),
    "Kaffee":               ("Coffee",                "Beverages",    "HOT",     0),
    "Kaffeebohnen":         ("Coffee Beans",          "Grocery",      "AMBIENT", 0),
    "Protein Riegel":       ("Protein Bars",          "Health",       "AMBIENT", 0),
    "Süsse Riegel":         ("Sweet Bars",            "Confectionery","AMBIENT", 0),
    "Süßigkeiten":          ("Sweets",                "Confectionery","AMBIENT", 0),
    "Schokolade":           ("Chocolate",             "Confectionery","AMBIENT", 0),
    "Bonbons":              ("Candy",                 "Confectionery","AMBIENT", 0),
    "Weingummi":            ("Gummy Sweets",          "Confectionery","AMBIENT", 0),
    "Kaugummi":             ("Chewing Gum",           "Confectionery","AMBIENT", 0),
    "Impulseis":            ("Impulse Ice Cream",     "Frozen",       "FROZEN",  0),
    "Tiefkühlkost":         ("Frozen Food",           "Frozen",       "FROZEN",  0),
    "Eiswürfel":            ("Ice Cubes",             "Frozen",       "FROZEN",  0),
    "Homemade Buns":        ("Homemade Buns",         "Food to Go",   "CHILLED", 1),
    "Sandwiches":           ("Sandwiches",            "Food to Go",   "CHILLED", 2),
    "Wraps":                ("Wraps",                 "Food to Go",   "CHILLED", 2),
    "Salate":               ("Salads",                "Food to Go",   "CHILLED", 2),
    "Lunchboxen":           ("Lunch Boxes",           "Food to Go",   "CHILLED", 2),
    "Fertiggerichte":       ("Ready Meals",           "Food to Go",   "CHILLED", 4),
    "Pizza  Baguette":      ("Pizza & Baguette",      "Food to Go",   "CHILLED", 3),
    "Frühstück":            ("Breakfast",             "Food to Go",   "CHILLED", 3),
    "Herzhafte Backwaren":  ("Savoury Bakery",        "Bakery",       "AMBIENT", 1),
    "Süße Backwaren":       ("Sweet Bakery",          "Bakery",       "AMBIENT", 1),
    "Süssgebäck":           ("Sweet Pastries",        "Bakery",       "AMBIENT", 2),
    "Brot":                 ("Bread",                 "Bakery",       "AMBIENT", 3),
    "Snacks":               ("Snacks",                "Snacks",       "AMBIENT", 0),
    "Chips":                ("Crisps",                "Snacks",       "AMBIENT", 0),
    "Cerealien":            ("Cereals",               "Grocery",      "AMBIENT", 0),
    "Teigwaren & Reis":     ("Pasta & Rice",          "Grocery",      "AMBIENT", 0),
    "Mehl & Zucker":        ("Flour & Sugar",         "Grocery",      "AMBIENT", 0),
    "Gewürze":              ("Spices",                "Grocery",      "AMBIENT", 0),
    "Öl":                   ("Cooking Oil",           "Grocery",      "AMBIENT", 0),
    "Essig":                ("Vinegar",               "Grocery",      "AMBIENT", 0),
    "Aufstrich":            ("Spreads",               "Grocery",      "AMBIENT", 0),
    "Konserven":            ("Canned Goods",          "Grocery",      "AMBIENT", 0),
    "Konserven Gemüse":     ("Canned Vegetables",     "Grocery",      "AMBIENT", 0),
    "Fischprodukte":        ("Fish Products",         "Grocery",      "CHILLED", 7),
    "Feinkost":             ("Delicatessen",          "Fresh",        "CHILLED", 5),
    "SB Wurstwaren":        ("Packed Cold Cuts",      "Fresh",        "CHILLED", 7),
    "Frisch Wurstwaren":    ("Fresh Cold Cuts",       "Fresh",        "CHILLED", 4),
    "Scheibenkäse":         ("Sliced Cheese",         "Fresh",        "CHILLED", 10),
    "Milch":                ("Milk",                  "Fresh",        "CHILLED", 7),
    "Butter":               ("Butter",                "Fresh",        "CHILLED", 21),
    "Eier":                 ("Eggs",                  "Fresh",        "CHILLED", 14),
    "Körperpflege":         ("Personal Care",         "Non-Food",     "AMBIENT", 0),
    "Drogerieartikel":      ("Drugstore",             "Non-Food",     "AMBIENT", 0),
    "Damenhygiene":         ("Feminine Care",         "Non-Food",     "AMBIENT", 0),
    "Desinfektion":         ("Sanitiser",             "Non-Food",     "AMBIENT", 0),
    "Reinigungsmittel":     ("Cleaning Products",     "Non-Food",     "AMBIENT", 0),
    "Freizeitartikel":      ("Lifestyle & Leisure",   "Non-Food",     "AMBIENT", 0),
}

DEFAULT_PROFILE = ("General Merchandise", "Grocery", "AMBIENT", 0)

# Cost as a share of the net selling price, by category. Convenience formats
# run thin on drinks and food-to-go and wider on non-food impulse lines.
COST_RATIO = {
    "Deposit": 1.00, "Beverages": 0.62, "Alcohol": 0.66, "Health": 0.55,
    "Confectionery": 0.58, "Frozen": 0.60, "Food to Go": 0.64, "Bakery": 0.55,
    "Snacks": 0.59, "Grocery": 0.68, "Fresh": 0.66, "Non-Food": 0.48,
}

# Minimum case quantity a supplier will ship, by category. Fresh lines that
# sell less than a case a day are the main source of write-offs.
CASE_SIZE = {
    "Food to Go": 6, "Bakery": 8, "Fresh": 6, "Frozen": 12,
    "Beverages": 12, "Grocery": 6, "Snacks": 10, "Confectionery": 10,
}

STORES = [
    # ID, name, format, city, area m2, opens, closes, catchment, lat, lon, demand factor
    ("WDF01", "S.Mart Walldorf Campus",   "AUTONOMOUS",   "Walldorf",   68.0,  0, 24, 22000, 49.294300,  8.642000, 1.00),
    ("WDF02", "S.Mart Walldorf WDF03",    "CAMPUS_KIOSK", "Walldorf",   34.0,  6, 20,  7500, 49.297100,  8.647300, 0.42),
    ("STR01", "S.Mart St. Leon-Rot",      "AUTONOMOUS",   "St. Leon-Rot", 55.0, 0, 24,  9000, 49.264000,  8.616000, 0.61),
    ("BLN01", "S.Mart Berlin Rosenthaler","CONVENIENCE",  "Berlin",     92.0,  6, 23, 15000, 52.526000, 13.401500, 1.34),
    ("MUC01", "S.Mart Munich Werksviertel","AUTONOMOUS",  "Munich",     61.0,  0, 24, 12000, 48.126500, 11.601000, 0.88),
    ("HAM01", "S.Mart Hamburg Hafencity", "FLAGSHIP",     "Hamburg",   140.0,  7, 22, 18000, 53.541000,  9.999000, 1.52),
]

# The export names three terminals; the network reuses the same mix.
POS_TEMPLATES = [
    ("PF", "payfree Autonomous Gate", "RFID_AUTONOMOUS", "payfree / Diebold Nixdorf"),
    ("SM", "Self Checkout Kiosk",     "SELF_CHECKOUT",   "Diebold Nixdorf DN Series"),
    ("MO", "Mobile Scan & Go",        "MOBILE",          "SAP Customer Checkout Mobile"),
]

SUPPLIERS = [
    ("SUP001", "Red Bull Deutschland",      "DE", 2, 0.985, 250.0),
    ("SUP002", "Koro Handels GmbH",         "DE", 4, 0.940, 400.0),
    ("SUP003", "Hochwald Foods",            "DE", 3, 0.962, 300.0),
    ("SUP004", "Welde Braumanufaktur",      "DE", 5, 0.930, 350.0),
    ("SUP005", "Aramark Fresh Kitchen",     "DE", 1, 0.975, 120.0),
    ("SUP006", "Coca-Cola European Partners","DE", 2, 0.990, 500.0),
    ("SUP007", "Nordic Trading AB",         "SE", 9, 0.905, 900.0),
    ("SUP008", "Vitamin Well Nordics",      "SE", 7, 0.921, 600.0),
    ("SUP009", "Regional Bakery Kraichgau", "DE", 1, 0.958, 100.0),
    ("SUP010", "Unilever Ice Cream DE",     "DE", 3, 0.968, 450.0),
]

SEGMENTS = ["Campus Regular", "Early Commuter", "Lunch Crowd", "Late Shift", "Occasional", "Fitness Focused"]
TIERS = ["BRONZE", "SILVER", "GOLD", "PLATINUM"]

FIRST_NAMES = ["Lena", "Jonas", "Mira", "Tobias", "Anja", "Felix", "Sofia", "Daniel", "Nora", "Elias",
               "Hanna", "Lukas", "Yara", "Milan", "Clara", "Aaron", "Ida", "Noah", "Emilia", "Jan",
               "Ravi", "Priya", "Chen", "Yuki", "Omar", "Fatima", "Marta", "Pablo", "Ingrid", "Sven"]
LAST_NAMES = ["Bauer", "Krause", "Hoffmann", "Schneider", "Wagner", "Becker", "Weber", "Fischer",
              "Meyer", "Schulz", "Lehmann", "Vogel", "Brandt", "Kern", "Roth", "Sommer",
              "Iyer", "Nakamura", "Haddad", "Novak", "Lindqvist", "Moreau"]


def slug(text: str) -> str:
    normal = unicodedata.normalize("NFKD", str(text))
    ascii_only = "".join(c for c in normal if not unicodedata.combining(c))
    keep = [c.upper() if c.isalnum() else "_" for c in ascii_only]
    return "".join(keep).strip("_")[:20] or "GRP"


def stable_choice(key: str, options: list):
    """Deterministic pick driven by a hash, so it survives row reordering."""
    digest = hashlib.md5(key.encode()).hexdigest()
    return options[int(digest, 16) % len(options)]


def money(value) -> float:
    return round(float(value or 0), 2)


class Writer:
    """Collects rows per entity and writes CAP-style `namespace-Entity.csv`."""

    def __init__(self, out: Path):
        self.out = out
        self.out.mkdir(parents=True, exist_ok=True)
        self.counts: dict[str, int] = {}

    def write(self, entity: str, rows: list[dict]) -> None:
        target = self.out / f"{NAMESPACE}-{entity}.csv"
        if not rows:
            target.write_text("")
            self.counts[entity] = 0
            return
        columns = list(rows[0].keys())
        with target.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)
        self.counts[entity] = len(rows)


# ---------------------------------------------------------------------------
# Load the canonical extract
# ---------------------------------------------------------------------------

def load_canonical(folder: Path) -> dict[str, pd.DataFrame]:
    tables = {}
    for name in ["articles", "article_groups", "hourly_sales", "cancellations",
                 "returns", "pos_systems", "payment_methods", "discounts", "taxes"]:
        path = folder / f"{name}.csv"
        tables[name] = pd.read_csv(path) if path.exists() else pd.DataFrame()
    latest = folder / "hourly_sales_latest.csv"
    if latest.exists():
        extra = pd.read_csv(latest)
        if not extra.empty and not tables["hourly_sales"].empty:
            tables["hourly_sales"] = pd.concat(
                [tables["hourly_sales"], extra], ignore_index=True
            ).drop_duplicates(subset=["hourStart", "articleName"], keep="first")
    return tables


# ---------------------------------------------------------------------------
# Master data
# ---------------------------------------------------------------------------

def build_stores() -> tuple[list[dict], list[dict], dict[str, float]]:
    stores, pos_systems, demand_factor = [], [], {}
    for (sid, name, fmt, city, area, opens, closes, catchment, lat, lon, factor) in STORES:
        stores.append({
            "ID": sid, "name": name, "format": fmt, "city": city, "country_code": "DE",
            "salesArea": area, "opensAt": opens, "closesAt": closes,
            "isReferenceStore": sid == "WDF01",
            "latitude": lat, "longitude": lon, "catchmentSize": catchment,
        })
        demand_factor[sid] = factor

        # The reference store keeps the terminal IDs used in the SAP export.
        if sid == "WDF01":
            terminals = [("PF02", "payfree Autonomous Gate", "RFID_AUTONOMOUS", "payfree / Diebold Nixdorf"),
                         ("SM01", "Self Checkout Kiosk", "SELF_CHECKOUT", "Diebold Nixdorf DN Series"),
                         ("MOB1", "Mobile Scan & Go", "MOBILE", "SAP Customer Checkout Mobile")]
        else:
            # Qualify with the full store ID - several stores share a numeric
            # suffix, so a prefix plus those digits would collide.
            terminals = [(f"{prefix}-{sid}", label, kind, vendor)
                         for (prefix, label, kind, vendor) in POS_TEMPLATES]
            # Staffed convenience formats have no autonomous gate.
            if fmt == "CONVENIENCE":
                terminals = terminals[1:]

        for (pid, label, kind, vendor) in terminals:
            pos_systems.append({
                "ID": pid, "name": label, "store_ID": sid, "kind": kind,
                "vendor": vendor,
                "healthScore": 100 if kind != "RFID_AUTONOMOUS" else 92,
            })
    return stores, pos_systems, demand_factor


def build_article_groups(groups: pd.DataFrame) -> tuple[list[dict], dict[str, str]]:
    rows, lookup = [], {}
    names = sorted(groups["articleGroup"].dropna().unique()) if not groups.empty else []
    for german in names:
        english, category, zone, shelf_life = GROUP_PROFILE.get(german, DEFAULT_PROFILE)
        gid = slug(german)
        lookup[german] = gid
        rows.append({
            "ID": gid, "name": english, "nameDE": german, "category": category,
            "tempZone": zone, "shelfLifeDays": shelf_life,
        })
    return rows, lookup


def build_articles(articles: pd.DataFrame, groups: pd.DataFrame,
                   group_lookup: dict[str, str], group_rows: list[dict]) -> list[dict]:
    group_by_article = dict(zip(groups["articleId"], groups["articleGroup"])) if not groups.empty else {}
    group_meta = {row["ID"]: row for row in group_rows}

    # Median price per group fills in articles that never sold in the period.
    priced = articles.dropna(subset=["unitPriceGross"]).copy()
    priced["gid"] = priced["articleId"].map(lambda a: group_lookup.get(group_by_article.get(a, ""), ""))
    median_price = priced.groupby("gid")["unitPriceGross"].median().to_dict()
    overall_median = float(priced["unitPriceGross"].median()) if not priced.empty else 1.50

    # ABC by cumulative revenue share, the usual 80/95 split.
    ranked = articles.sort_values("grossSales", ascending=False).copy()
    total_revenue = float(ranked["grossSales"].sum()) or 1.0
    ranked["cumulative"] = ranked["grossSales"].cumsum() / total_revenue
    abc = {}
    for row in ranked.itertuples():
        abc[row.articleId] = "A" if row.cumulative <= 0.80 else ("B" if row.cumulative <= 0.95 else "C")

    rng = random.Random(SEED)
    rows = []
    for record in articles.itertuples():
        aid = str(record.articleId)
        german = group_by_article.get(aid)
        gid = group_lookup.get(german) if german else None
        meta = group_meta.get(gid, {})
        category = meta.get("category", "Grocery")

        price = record.unitPriceGross
        if pd.isna(price) or not price:
            price = median_price.get(gid, overall_median)
        price = round(float(price), 4)

        vat = record.vatRatePct
        if pd.isna(vat):
            # German food is taxed at 7%, everything else at 19%.
            vat = 7.0 if category in {"Food to Go", "Bakery", "Fresh", "Grocery", "Snacks", "Confectionery", "Frozen"} else 19.0
        vat = round(float(vat), 2)

        is_deposit = category == "Deposit"
        net_price = price / (1 + vat / 100)
        ratio = COST_RATIO.get(category, 0.62)
        cost = round(net_price * ratio, 4)

        shelf_life = int(meta.get("shelfLifeDays", 0) or 0)
        sold = float(record.quantitySold or 0)
        # Face the shelf to roughly a week of observed demand, floored so slow
        # movers still get a sensible presentation quantity.
        capacity = max(6, int(math.ceil(sold / 179 * 7)) if sold else 6)
        capacity = min(capacity, 120)

        rows.append({
            "ID": aid,
            "name": str(record.articleName),
            "group_ID": gid,
            "supplier_ID": stable_choice(aid, [s[0] for s in SUPPLIERS]),
            "unitPriceGross": price,
            "unitCost": cost if not is_deposit else 0.0,
            "vatRatePct": vat,
            "currency_code": CURRENCY,
            "isDeposit": is_deposit,
            # Deposit lines are scanned, not tagged; a few slow movers are not
            # tagged either, which is what makes them cancellation-prone.
            "isRfidTagged": (not is_deposit) and (rng.random() > 0.04),
            "shelfLifeDays": shelf_life,
            "abcClass": abc.get(aid, "C"),
            "shelfCapacity": capacity,
            "reorderPoint": max(2, int(capacity * 0.35)),
            "isFromSapExport": True,
        })
    return rows


def build_suppliers() -> list[dict]:
    return [{
        "ID": sid, "name": name, "country_code": country, "leadTimeDays": lead,
        "reliability": rel, "minOrderValue": mov,
    } for (sid, name, country, lead, rel, mov) in SUPPLIERS]


def build_people(stores: list[dict], rng: random.Random) -> tuple[list[dict], list[dict]]:
    customers = []
    for index in range(1, 481):
        cid = f"CUST{index:05d}"
        home = rng.choice(stores)["ID"]
        tier = rng.choices(TIERS, weights=[45, 30, 18, 7])[0]
        enrolled = date(2025, 1, 1) + timedelta(days=rng.randint(0, 540))
        customers.append({
            "ID": cid,
            "appUserId": f"smart-app-{index:05d}",
            "displayName": f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_NAMES)}",
            "segment": rng.choice(SEGMENTS),
            "loyaltyTier": tier,
            "loyaltyPoints": rng.randint(0, 4800),
            "enrolledOn": enrolled.isoformat(),
            "consentMarketing": rng.random() < 0.68,
            "homeStore_ID": home,
        })

    roles = ["Store Manager", "Shift Lead", "Replenishment Associate", "Fresh Food Associate", "Remote Supervisor"]
    employees = []
    counter = 1
    for store in stores:
        for role in roles[: 3 if store["format"] in {"AUTONOMOUS", "CAMPUS_KIOSK"} else 5]:
            eid = f"EMP{counter:04d}"
            employees.append({
                "ID": eid,
                "name": f"{rng.choice(FIRST_NAMES)} {rng.choice(LAST_NAMES)}",
                "role": role,
                "store_ID": store["ID"],
                # Matches the cashier identity SAP Customer Checkout records.
                "cashierId": "smart01" if role == "Store Manager" else f"op{counter:03d}",
            })
            counter += 1
    return customers, employees


# ---------------------------------------------------------------------------
# Demand profile learned from the real export
# ---------------------------------------------------------------------------

class DemandProfile:
    """Hour-of-day, day-of-week and article-mix weights taken from the export."""

    def __init__(self, hourly: pd.DataFrame, name_to_id: dict[str, str]):
        frame = hourly.copy()
        frame["articleId"] = frame["articleName"].map(name_to_id)
        frame = frame[frame["articleId"].notna()].copy()
        frame["hourStart"] = pd.to_datetime(frame["hourStart"])
        self.frame = frame

        hour_totals = frame.groupby("hour")["quantity"].sum()
        self.hour_weight = (hour_totals / hour_totals.sum()).to_dict()

        dow_totals = frame.groupby("dayOfWeek")["quantity"].sum()
        day_counts = frame.groupby("dayOfWeek")["date"].nunique()
        per_day = (dow_totals / day_counts)
        self.dow_weight = (per_day / per_day.mean()).to_dict()

        article_totals = frame.groupby("articleId")["quantity"].sum()
        self.article_weight = (article_totals / article_totals.sum()).to_dict()

        self.daily_units = float(frame["quantity"].sum()) / max(frame["date"].nunique(), 1)
        self.start = frame["hourStart"].min()
        self.end = frame["hourStart"].max()

    def hour_share(self, hour: int) -> float:
        return self.hour_weight.get(hour, 0.0)

    def day_multiplier(self, weekday: int) -> float:
        return self.dow_weight.get(weekday, 1.0)


def build_hourly_sales(profile: DemandProfile, stores: list[dict], demand_factor: dict[str, float],
                       articles_by_id: dict[str, dict], rng: random.Random) -> list[dict]:
    """
    Walldorf's rows are copied through unchanged; the other stores replay the
    same shape at their own scale, with per-store noise and a mix that leans
    toward each format (food-to-go in flagships, drinks in kiosks).
    """
    rows: list[dict] = []

    for record in profile.frame.itertuples():
        gross = money(record.dueAmount)
        rows.append({
            "ID": f"HS-WDF01-{record.Index:06d}",
            "hourStart": pd.Timestamp(record.hourStart).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "businessDate": str(record.date),
            "hourOfDay": int(record.hour),
            "dayOfWeek": int(record.dayOfWeek),
            "store_ID": "WDF01",
            "article_ID": record.articleId,
            "quantity": float(record.quantity),
            "netRevenue": money(record.netRevenue),
            "vatAmount": money(record.vatAmount),
            "grossAmount": gross,
            "currency_code": CURRENCY,
            "isActual": True,
        })

    article_ids = list(profile.article_weight.keys())
    weights = [profile.article_weight[a] for a in article_ids]

    # Format bias: which categories over-index in which store format.
    format_bias = {
        "FLAGSHIP":     {"Food to Go": 1.9, "Fresh": 1.5, "Bakery": 1.4, "Beverages": 0.9},
        "CONVENIENCE":  {"Grocery": 1.6, "Non-Food": 1.5, "Fresh": 1.2, "Beverages": 0.95},
        "CAMPUS_KIOSK": {"Beverages": 1.5, "Snacks": 1.4, "Confectionery": 1.3, "Food to Go": 0.7},
        "AUTONOMOUS":   {},
    }
    group_category = {}
    for aid, article in articles_by_id.items():
        group_category[aid] = article.get("_category", "Grocery")

    counter = 0
    start_day = profile.start.date()
    end_day = profile.end.date()

    for store in stores:
        sid = store["ID"]
        if sid == "WDF01":
            continue
        factor = demand_factor[sid]
        bias = format_bias.get(store["format"], {})
        store_weights = [
            weight * bias.get(group_category.get(aid, "Grocery"), 1.0)
            for aid, weight in zip(article_ids, weights)
        ]
        total_weight = sum(store_weights) or 1.0
        store_weights = [w / total_weight for w in store_weights]

        current = start_day
        while current <= end_day:
            weekday = current.weekday()
            # Campus stores empty out at the weekend; city stores do not.
            weekend_damping = 1.0
            if store["format"] in {"AUTONOMOUS", "CAMPUS_KIOSK"} and weekday >= 5:
                weekend_damping = 0.35
            elif weekday >= 5:
                weekend_damping = 0.85

            day_units = (profile.daily_units * factor
                         * profile.day_multiplier(weekday)
                         * weekend_damping
                         * rng.uniform(0.78, 1.24))

            for hour in range(store["opensAt"], min(store["closesAt"], 24)):
                share = profile.hour_share(hour)
                if share <= 0:
                    continue
                expected = day_units * share
                if expected <= 0:
                    continue
                units = max(0, int(rng.gauss(expected, expected * 0.45)))
                if units == 0:
                    continue

                picks = rng.choices(article_ids, weights=store_weights, k=min(units, 14))
                basket = defaultdict(int)
                for aid in picks:
                    basket[aid] += max(1, units // max(len(picks), 1))

                for aid, quantity in basket.items():
                    article = articles_by_id.get(aid)
                    if not article:
                        continue
                    gross = round(quantity * float(article["unitPriceGross"]), 2)
                    vat_rate = float(article["vatRatePct"])
                    net = round(gross / (1 + vat_rate / 100), 2)
                    counter += 1
                    rows.append({
                        "ID": f"HS-{sid}-{counter:06d}",
                        "hourStart": datetime.combine(current, datetime.min.time()).replace(hour=hour).strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "businessDate": current.isoformat(),
                        "hourOfDay": hour,
                        "dayOfWeek": weekday,
                        "store_ID": sid,
                        "article_ID": aid,
                        "quantity": float(quantity),
                        "netRevenue": net,
                        "vatAmount": round(gross - net, 2),
                        "grossAmount": gross,
                        "currency_code": CURRENCY,
                        "isActual": True,
                    })
            current += timedelta(days=1)
    return rows


# ---------------------------------------------------------------------------
# Receipts reconstructed from the hourly grain
# ---------------------------------------------------------------------------

def build_receipts(hourly_rows: list[dict], stores_by_id: dict[str, dict],
                   pos_by_store: dict[str, list[dict]], customers: list[dict],
                   articles_by_id: dict[str, dict], payment_mix: list[tuple[str, float]],
                   rng: random.Random) -> tuple[list[dict], list[dict]]:
    """
    The export gives hourly aggregates, not baskets. Group each store-hour's
    articles into plausible receipts so the affinity engine has real baskets to
    mine, keeping the hourly revenue totals intact.
    """
    by_hour: dict[tuple, list[dict]] = defaultdict(list)
    for row in hourly_rows:
        by_hour[(row["store_ID"], row["hourStart"])].append(row)

    methods = [m for m, _ in payment_mix]
    weights = [w for _, w in payment_mix]

    receipts, items = [], []
    receipt_counter = 0
    customers_by_store = defaultdict(list)
    for customer in customers:
        customers_by_store[customer["homeStore_ID"]].append(customer)

    for (store_id, hour_start), lines in sorted(by_hour.items()):
        terminals = pos_by_store.get(store_id) or []
        if not terminals:
            continue
        # Autonomous gates carry the bulk of traffic, matching the export where
        # payfree took 1,664 of 2,550 receipts.
        terminal_weights = [
            0.62 if t["kind"] == "RFID_AUTONOMOUS" else (0.32 if t["kind"] == "SELF_CHECKOUT" else 0.06)
            for t in terminals
        ]

        pool = []
        for line in lines:
            pool.extend([line] * max(1, int(round(float(line["quantity"])))))
        rng.shuffle(pool)

        while pool:
            basket_size = min(len(pool), max(1, int(rng.gauss(2.4, 1.3))))
            chosen = pool[:basket_size]
            pool = pool[basket_size:]

            terminal = rng.choices(terminals, weights=terminal_weights)[0]
            receipt_counter += 1
            receipt_id = f"RC-{store_id}-{receipt_counter:07d}"
            timestamp = datetime.strptime(hour_start, "%Y-%m-%dT%H:%M:%SZ") + timedelta(
                minutes=rng.randint(0, 59), seconds=rng.randint(0, 59))

            candidates = customers_by_store.get(store_id) or customers
            # Autonomous entry needs the app, so those receipts always have an
            # identified customer; the staffed terminals often do not.
            customer_id = ""
            if terminal["kind"] == "RFID_AUTONOMOUS" or rng.random() < 0.35:
                customer_id = rng.choice(candidates)["ID"] if candidates else ""

            aggregated = defaultdict(float)
            for line in chosen:
                aggregated[line["article_ID"]] += 1.0

            net_total = vat_total = gross_total = discount_total = 0.0
            for article_id, quantity in aggregated.items():
                article = articles_by_id.get(article_id)
                if not article:
                    continue
                unit_price = float(article["unitPriceGross"])
                vat_rate = float(article["vatRatePct"])
                # Discount mix mirrors the export: ~15% of lines carry one.
                discount_pct, discount_type = 0.0, "No discount"
                roll = rng.random()
                if roll < 0.12:
                    discount_pct, discount_type = round(rng.uniform(5, 25), 2), "Price changed"
                elif roll < 0.145:
                    discount_pct, discount_type = round(rng.uniform(20, 50), 2), "General"
                elif roll < 0.15:
                    discount_pct, discount_type = round(rng.uniform(5, 15), 2), "Promotion"

                gross = quantity * unit_price * (1 - discount_pct / 100)
                net = gross / (1 + vat_rate / 100)
                discount_total += quantity * unit_price * (discount_pct / 100)
                net_total += net
                vat_total += gross - net
                gross_total += gross

                items.append({
                    "ID": f"{receipt_id}-{len(items):07d}",
                    "receipt_ID": receipt_id,
                    "article_ID": article_id,
                    "quantity": quantity,
                    "unitPrice": unit_price,
                    "netAmount": money(net),
                    "grossAmount": money(gross),
                    "discountPct": discount_pct,
                    "discountType": discount_type,
                })

            receipts.append({
                "ID": receipt_id,
                "receiptNumber": f"{store_id}-{receipt_counter:07d}",
                "store_ID": store_id,
                "posSystem_ID": terminal["ID"],
                "customer_ID": customer_id,
                "businessDate": timestamp.date().isoformat(),
                "createdAt": timestamp.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "netRevenue": money(net_total),
                "vatAmount": money(vat_total),
                "grossAmount": money(gross_total),
                "discountAmount": money(discount_total),
                "currency_code": CURRENCY,
                "paymentMethod": rng.choices(methods, weights=weights)[0],
                "itemCount": len(aggregated),
                # payfree advertises sub-50-second trips; staffed lanes are slower.
                "dwellSeconds": int(rng.gauss(46, 14)) if terminal["kind"] == "RFID_AUTONOMOUS" else int(rng.gauss(115, 40)),
            })
    return receipts, items


# ---------------------------------------------------------------------------
# Loss facts
# ---------------------------------------------------------------------------

def build_cancellations(canonical: pd.DataFrame, name_to_id: dict[str, str],
                        stores: list[dict], pos_by_store: dict[str, list[dict]],
                        hourly_rows: list[dict], articles_by_id: dict[str, dict],
                        rng: random.Random) -> list[dict]:
    rows = []
    dates_by_store = defaultdict(set)
    for row in hourly_rows:
        dates_by_store[row["store_ID"]].add(row["businessDate"])

    walldorf_dates = sorted(dates_by_store.get("WDF01", []))
    pos_lookup = {p["ID"]: p for terminals in pos_by_store.values() for p in terminals}

    # Real Walldorf cancellations. The export aggregates them over the whole
    # period, so spread each article's total across the days it actually sold,
    # keeping the totals per article exact.
    for record in canonical.itertuples():
        aid = str(record.articleId)
        if aid not in articles_by_id:
            continue
        cashier = str(record.cashier)
        terminal = "PF02" if cashier == "payfree" else ("SM01" if cashier == "smart" else "MOB1")
        total_count = int(record.cancellationCount or 0)
        total_qty = float(record.cancelledQuantity or 0)
        total_amount = float(record.cancelledAmount or 0)
        if total_count <= 0:
            continue

        spread = min(max(total_count // 3, 1), 45)
        chosen_days = rng.sample(walldorf_dates, min(spread, len(walldorf_dates))) if walldorf_dates else []
        if not chosen_days:
            continue

        base_count = total_count // len(chosen_days)
        base_qty = total_qty / len(chosen_days)
        base_amount = total_amount / len(chosen_days)
        remainder = total_count - base_count * len(chosen_days)

        for index, day in enumerate(sorted(chosen_days)):
            count = base_count + (1 if index < remainder else 0)
            if count <= 0:
                continue
            rows.append({
                "ID": f"CN-WDF01-{len(rows):06d}",
                "store_ID": "WDF01",
                "posSystem_ID": terminal,
                "article_ID": aid,
                "cashier": cashier,
                "businessDate": day,
                "cancellationCount": count,
                "cancelledQuantity": round(base_qty, 3),
                "cancelledAmount": money(base_amount),
                "currency_code": CURRENCY,
            })

    # Synthesized stores: cancellations scale with autonomous traffic, at a
    # lower rate where a human is present to resolve a misread.
    for store in stores:
        sid = store["ID"]
        if sid == "WDF01":
            continue
        terminals = pos_by_store.get(sid, [])
        for day in sorted(dates_by_store.get(sid, [])):
            for terminal in terminals:
                if terminal["kind"] == "RFID_AUTONOMOUS":
                    events = rng.randint(0, 9)
                elif terminal["kind"] == "SELF_CHECKOUT":
                    events = rng.randint(0, 4)
                else:
                    events = 1 if rng.random() < 0.15 else 0
                for _ in range(events):
                    article = rng.choice(list(articles_by_id.values()))
                    quantity = rng.randint(1, 3)
                    rows.append({
                        "ID": f"CN-{sid}-{len(rows):06d}",
                        "store_ID": sid,
                        "posSystem_ID": terminal["ID"],
                        "article_ID": article["ID"],
                        "cashier": "payfree" if terminal["kind"] == "RFID_AUTONOMOUS" else "smart",
                        "businessDate": day,
                        "cancellationCount": 1,
                        "cancelledQuantity": float(quantity),
                        "cancelledAmount": money(quantity * float(article["unitPriceGross"])),
                        "currency_code": CURRENCY,
                    })
    return rows


def build_returns(canonical: pd.DataFrame, articles_by_id: dict[str, dict],
                  hourly_rows: list[dict], stores: list[dict], rng: random.Random) -> list[dict]:
    rows = []
    dates_by_store = defaultdict(set)
    for row in hourly_rows:
        dates_by_store[row["store_ID"]].add(row["businessDate"])
    walldorf_dates = sorted(dates_by_store.get("WDF01", []))

    for record in canonical.itertuples():
        aid = str(record.articleId)
        if aid not in articles_by_id or not walldorf_dates:
            continue
        rows.append({
            "ID": f"RT-WDF01-{len(rows):05d}",
            "store_ID": "WDF01",
            "article_ID": aid,
            "businessDate": rng.choice(walldorf_dates),
            "returnCount": int(record.returnCount or 0),
            "returnedQuantity": float(record.returnedQuantity or 0),
            "returnedAmount": money(record.returnedAmount),
            "reason": str(record.reason) if str(record.reason) != "nan" else "No reason",
            "currency_code": CURRENCY,
        })

    reasons = ["Damaged packaging", "Wrong item", "Quality complaint", "No reason", "Expired on shelf"]
    for store in stores:
        sid = store["ID"]
        if sid == "WDF01":
            continue
        for day in sorted(dates_by_store.get(sid, [])):
            if rng.random() > 0.10:
                continue
            article = rng.choice(list(articles_by_id.values()))
            quantity = rng.randint(1, 2)
            rows.append({
                "ID": f"RT-{sid}-{len(rows):05d}",
                "store_ID": sid,
                "article_ID": article["ID"],
                "businessDate": day,
                "returnCount": 1,
                "returnedQuantity": float(quantity),
                "returnedAmount": money(quantity * float(article["unitPriceGross"])),
                "reason": rng.choice(reasons),
                "currency_code": CURRENCY,
            })
    return rows


def build_payment_facts(canonical: pd.DataFrame, receipts: list[dict]) -> tuple[list[dict], list[tuple[str, float]]]:
    """Real payment split for Walldorf; the network rolls up from its receipts."""
    rows = []
    mix_counts: dict[str, float] = defaultdict(float)
    for record in canonical.itertuples():
        method = str(record.paymentMethod)
        mix_counts[method] += float(record.itemCount or 0)
        rows.append({
            "ID": f"PM-WDF01-{len(rows):05d}",
            "store_ID": "WDF01",
            "posSystem_ID": str(record.posSystemId),
            "businessDate": "2026-07-03",
            "paymentMethod": method,
            "itemCount": int(record.itemCount or 0),
            "amount": money(record.amount),
            "currency_code": CURRENCY,
        })

    total = sum(mix_counts.values()) or 1.0
    mix = sorted(((m, c / total) for m, c in mix_counts.items()), key=lambda x: -x[1])

    aggregated: dict[tuple, dict] = {}
    for receipt in receipts:
        if receipt["store_ID"] == "WDF01":
            continue
        key = (receipt["store_ID"], receipt["posSystem_ID"], receipt["businessDate"], receipt["paymentMethod"])
        bucket = aggregated.setdefault(key, {"itemCount": 0, "amount": 0.0})
        bucket["itemCount"] += 1
        bucket["amount"] += receipt["grossAmount"]

    for (store_id, pos_id, day, method), bucket in sorted(aggregated.items()):
        rows.append({
            "ID": f"PM-{store_id}-{len(rows):05d}",
            "store_ID": store_id,
            "posSystem_ID": pos_id,
            "businessDate": day,
            "paymentMethod": method,
            "itemCount": bucket["itemCount"],
            "amount": money(bucket["amount"]),
            "currency_code": CURRENCY,
        })
    return rows, mix


# ---------------------------------------------------------------------------
# Inventory and telemetry
# ---------------------------------------------------------------------------

def build_inventory(hourly_rows: list[dict], articles_by_id: dict[str, dict],
                    stores: list[dict], rng: random.Random) -> list[dict]:
    """
    Daily snapshots for the last 21 trading days. Book stock drifts away from
    counted stock at a rate that depends on how tagged the article is, which is
    what the shrink engine later picks up.
    """
    sold = defaultdict(float)
    all_dates = set()
    for row in hourly_rows:
        sold[(row["store_ID"], row["article_ID"], row["businessDate"])] += float(row["quantity"])
        all_dates.add(row["businessDate"])

    recent = sorted(all_dates)[-21:]
    velocity = defaultdict(list)
    for (store_id, article_id, day), quantity in sold.items():
        velocity[(store_id, article_id)].append(quantity)

    total_days = len({day for (_, _, day) in sold})

    rows = []
    for store in stores:
        sid = store["ID"]
        open_hours = max(1, store["closesAt"] - store["opensAt"])
        tracked = [key for key in velocity if key[0] == sid]
        # Keep the snapshot table to the articles that actually move.
        tracked.sort(key=lambda k: -sum(velocity[k]))
        tracked = tracked[:140]

        for (_, article_id) in tracked:
            article = articles_by_id.get(article_id)
            if not article:
                continue
            daily = sum(velocity[(sid, article_id)]) / max(total_days, 1)
            capacity = float(article["shelfCapacity"])
            shelf_life = int(article.get("shelfLifeDays") or 0)
            is_perishable = 0 < shelf_life <= 4

            for day in recent:
                sold_today = sold.get((sid, article_id, day), 0.0)
                if is_perishable:
                    # Fresh lines arrive as a batch each morning. Suppliers ship
                    # whole cases, so a line selling well under a case a day
                    # still gets a full case - which is where most fresh waste
                    # actually comes from, and what the markdown engine manages.
                    case_size = CASE_SIZE.get(article.get("_category", ""), 6)
                    batch = max(float(case_size), math.ceil(daily * rng.uniform(1.15, 1.75)))
                    book = round(max(0.0, batch - sold_today * rng.uniform(0.35, 0.8)), 3)
                    on_order = float(case_size)
                else:
                    # Ambient lines run down between deliveries, so on-hand sits
                    # somewhere between a full facing and the reorder point.
                    depletion = rng.uniform(0.25, 0.95)
                    book = round(max(0.0, capacity * (1 - depletion) + rng.uniform(0, 3)), 3)
                    on_order = float(rng.randint(0, max(1, int(capacity * 0.5))))

                # Untagged articles lose more to unrecorded removals, which is
                # the variance the shrink engine looks for.
                drift = rng.uniform(0.0, 0.9) if article["isRfidTagged"] else rng.uniform(0.5, 3.0)
                counted = round(max(0.0, book - drift), 3)
                hourly = daily / open_hours if open_hours else 0
                days_of_supply = round(counted / daily, 2) if daily > 0 else 99.0
                rows.append({
                    "ID": f"IV-{sid}-{article_id}-{day}",
                    "store_ID": sid,
                    "article_ID": article_id,
                    "businessDate": day,
                    "bookStock": book,
                    "countedStock": counted,
                    "onOrder": on_order,
                    "daysOfSupply": min(days_of_supply, 99.0),
                })
    return rows


def build_sensors(hourly_rows: list[dict], articles_by_id: dict[str, dict],
                  group_by_id: dict[str, dict], stores: list[dict], rng: random.Random) -> list[dict]:
    days = sorted({row["businessDate"] for row in hourly_rows})[-7:]
    rows = []
    chilled_articles = [
        a for a in articles_by_id.values()
        if group_by_id.get(a.get("group_ID") or "", {}).get("tempZone") in {"CHILLED", "FROZEN"}
    ]
    movers = defaultdict(float)
    for row in hourly_rows:
        movers[(row["store_ID"], row["article_ID"])] += float(row["quantity"])

    for store in stores:
        sid = store["ID"]
        top = sorted([k for k in movers if k[0] == sid], key=lambda k: -movers[k])[:25]
        for day in days:
            for (_, article_id) in top:
                for hour in (9, 13, 17):
                    reading_at = f"{day}T{hour:02d}:00:00Z"
                    fill = max(0.0, min(1.0, rng.gauss(0.62, 0.26)))
                    rows.append({
                        "ID": f"SN-{sid}-{article_id}-{day}-{hour}-V",
                        "store_ID": sid, "article_ID": article_id,
                        "readingAt": reading_at, "sensorType": "VISION_STOCKOUT",
                        "value": round(fill, 3), "unit": "ratio",
                        "isAnomaly": fill < 0.15,
                    })
            # Electronic shelf labels report the price they are displaying; a
            # mismatch with the master price is a real-world integrity issue.
            for (_, article_id) in top[:8]:
                article = articles_by_id[article_id]
                displayed = float(article["unitPriceGross"])
                if rng.random() < 0.04:
                    displayed = round(displayed * rng.uniform(0.75, 1.3), 2)
                rows.append({
                    "ID": f"SN-{sid}-{article_id}-{day}-ESL",
                    "store_ID": sid, "article_ID": article_id,
                    "readingAt": f"{day}T06:00:00Z", "sensorType": "ESL",
                    "value": displayed, "unit": CURRENCY,
                    "isAnomaly": abs(displayed - float(article["unitPriceGross"])) > 0.01,
                })

            for index, article in enumerate(rng.sample(chilled_articles, min(6, len(chilled_articles)))):
                zone = group_by_id.get(article.get("group_ID") or "", {}).get("tempZone")
                target = -18.0 if zone == "FROZEN" else 5.0
                measured = round(rng.gauss(target, 1.4), 2)
                if rng.random() < 0.05:
                    measured = round(target + rng.uniform(3.5, 9.0), 2)
                rows.append({
                    "ID": f"SN-{sid}-{day}-T{index}",
                    "store_ID": sid, "article_ID": article["ID"],
                    "readingAt": f"{day}T12:00:00Z", "sensorType": "TEMPERATURE",
                    "value": measured, "unit": "C",
                    "isAnomaly": abs(measured - target) > 3.0,
                })
    return rows


def build_footfall(hourly_rows: list[dict], stores_by_id: dict[str, dict], rng: random.Random) -> list[dict]:
    """Visitors per store-hour, back-solved from receipts and a conversion rate."""
    buckets = defaultdict(lambda: {"quantity": 0.0, "hour": 0, "date": ""})
    for row in hourly_rows:
        key = (row["store_ID"], row["hourStart"])
        bucket = buckets[key]
        bucket["quantity"] += float(row["quantity"])
        bucket["hour"] = row["hourOfDay"]
        bucket["date"] = row["businessDate"]

    rows = []
    for (store_id, hour_start), bucket in sorted(buckets.items()):
        store = stores_by_id[store_id]
        # Autonomous stores convert far better: entry needs the app, so almost
        # everyone who walks in intends to buy.
        base_conversion = 0.82 if store["format"] == "AUTONOMOUS" else 0.54
        conversion = max(0.15, min(0.98, rng.gauss(base_conversion, 0.09)))
        buyers = max(1, int(round(bucket["quantity"] / 2.4)))
        visitors = max(buyers, int(round(buyers / conversion)))
        rows.append({
            "ID": f"FF-{store_id}-{hour_start[:13]}",
            "store_ID": store_id,
            "hourStart": hour_start,
            "businessDate": bucket["date"],
            "hourOfDay": bucket["hour"],
            "visitors": visitors,
            "conversionRate": round(buyers / visitors, 4),
            "avgDwellSeconds": int(rng.gauss(52 if store["format"] == "AUTONOMOUS" else 168, 20)),
        })
    return rows


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--canonical", type=Path, default=Path("data/canonical"))
    parser.add_argument("--out", type=Path, default=Path("db/data"))
    args = parser.parse_args()

    rng = random.Random(SEED)
    canonical = load_canonical(args.canonical)
    if canonical["articles"].empty:
        sys.exit("No canonical articles found - run tools/etl_sap_export.py first.")

    writer = Writer(args.out)

    stores, pos_systems, demand_factor = build_stores()
    group_rows, group_lookup = build_article_groups(canonical["article_groups"])
    article_rows = build_articles(canonical["articles"], canonical["article_groups"],
                                  group_lookup, group_rows)
    supplier_rows = build_suppliers()
    customers, employees = build_people(stores, rng)

    group_by_id = {row["ID"]: row for row in group_rows}
    articles_by_id = {}
    for article in article_rows:
        enriched = dict(article)
        enriched["_category"] = group_by_id.get(article.get("group_ID") or "", {}).get("category", "Grocery")
        articles_by_id[article["ID"]] = enriched

    name_to_id = {row["name"]: row["ID"] for row in article_rows}
    stores_by_id = {s["ID"]: s for s in stores}
    pos_by_store = defaultdict(list)
    for terminal in pos_systems:
        pos_by_store[terminal["store_ID"]].append(terminal)

    profile = DemandProfile(canonical["hourly_sales"], name_to_id)
    print(f"Learned demand profile: {profile.daily_units:.1f} units/day, "
          f"{profile.start.date()} .. {profile.end.date()}")

    hourly_rows = build_hourly_sales(profile, stores, demand_factor, articles_by_id, rng)
    payment_rows_seed = canonical["payment_methods"]
    _, payment_mix = build_payment_facts(payment_rows_seed, [])
    receipts, receipt_items = build_receipts(hourly_rows, stores_by_id, pos_by_store,
                                             customers, articles_by_id, payment_mix, rng)
    payment_rows, _ = build_payment_facts(payment_rows_seed, receipts)

    cancellations = build_cancellations(canonical["cancellations"], name_to_id, stores,
                                        pos_by_store, hourly_rows, articles_by_id, rng)
    returns = build_returns(canonical["returns"], articles_by_id, hourly_rows, stores, rng)
    inventory = build_inventory(hourly_rows, articles_by_id, stores, rng)
    sensors = build_sensors(hourly_rows, articles_by_id, group_by_id, stores, rng)
    footfall = build_footfall(hourly_rows, stores_by_id, rng)

    # Strip the helper field before writing.
    clean_articles = [{k: v for k, v in a.items() if not k.startswith("_")} for a in article_rows]

    writer.write("Stores", stores)
    writer.write("PosSystems", pos_systems)
    writer.write("Suppliers", supplier_rows)
    writer.write("ArticleGroups", group_rows)
    writer.write("Articles", clean_articles)
    writer.write("Customers", customers)
    writer.write("Employees", employees)
    writer.write("HourlySales", hourly_rows)
    writer.write("Receipts", receipts)
    writer.write("ReceiptItems", receipt_items)
    writer.write("Cancellations", cancellations)
    writer.write("Returns", returns)
    writer.write("PaymentFacts", payment_rows)
    writer.write("InventorySnapshots", inventory)
    writer.write("ShelfSensorReadings", sensors)
    writer.write("FootfallReadings", footfall)

    print("\nGenerated:")
    for entity, count in writer.counts.items():
        print(f"  {entity:<22} {count:>8,}")

    real = sum(1 for row in hourly_rows if row["store_ID"] == "WDF01")
    print(f"\nHourly sales rows from the SAP export: {real:,} of {len(hourly_rows):,}")


if __name__ == "__main__":
    main()
