'use strict';

/**
 * Minimal RFC-4180 CSV reader/writer.
 *
 * The build pipeline hands data between Python and Node through the same CSV
 * files CAP loads at deploy time, so both ends have to agree on quoting. This
 * is deliberately dependency-free: it runs during `npm run build:ai` before any
 * optional tooling is guaranteed to be present.
 */

const fs = require('fs');
const path = require('path');

/** Values that should come back as real booleans rather than strings. */
const TRUE_VALUES = new Set(['true', 'TRUE', 'True']);
const FALSE_VALUES = new Set(['false', 'FALSE', 'False']);

function parseCsv(text) {
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n') {
      record.push(field);
      rows.push(record);
      record = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  // Flush whatever the file ended on, unless it ended cleanly on a newline.
  if (field !== '' || record.length) {
    record.push(field);
    rows.push(record);
  }
  return rows;
}

/**
 * Read a CSV into an array of objects keyed by the header row.
 * Booleans are coerced; everything else stays a string so that ids with
 * leading zeros survive intact.
 */
function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return [];

  const rows = parseCsv(text);
  if (!rows.length) return [];

  const header = rows[0].map((column) => column.trim());
  const records = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.length === 1 && row[0] === '') continue;
    const record = {};
    for (let column = 0; column < header.length; column += 1) {
      const value = row[column] ?? '';
      if (TRUE_VALUES.has(value)) record[header[column]] = true;
      else if (FALSE_VALUES.has(value)) record[header[column]] = false;
      else record[header[column]] = value;
    }
    records.push(record);
  }
  return records;
}

function escapeField(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/**
 * Write records to CSV. Column order comes from the union of all keys, so a
 * row that carries an extra field does not silently lose it.
 */
function writeCsv(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!records.length) {
    fs.writeFileSync(file, '');
    return 0;
  }
  const columns = [];
  const seen = new Set();
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) {
        seen.add(key);
        columns.push(key);
      }
    }
  }
  const lines = [columns.join(',')];
  for (const record of records) {
    lines.push(columns.map((column) => escapeField(record[column])).join(','));
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return records.length;
}

module.exports = { readCsv, writeCsv, parseCsv };
