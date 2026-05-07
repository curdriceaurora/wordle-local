// Minimal RFC 4180 CSV writer + classroom-friendly bulk-name reader.
// CRLF line endings, double-quote escape rule, optional UTF-8 BOM.

const CRLF = "\r\n";
const UTF8_BOM = "\uFEFF";

function escapeField(value) {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.length === 0) return "";
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function buildCsv(rows, options = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return options.bom ? UTF8_BOM : "";
  }
  const lines = rows.map((row) => {
    if (!Array.isArray(row)) {
      return "";
    }
    return row.map((cell) => escapeField(cell)).join(",");
  });
  const body = lines.join(CRLF) + CRLF;
  return options.bom ? `${UTF8_BOM}${body}` : body;
}

// Parse a single-column "names" payload — newline-separated names with
// optional commas/quotes per RFC 4180, but only the first column is kept.
// Returns { names, errors } where errors is a list of `{line, message}`.
// `lineLimit` defaults to 1000 to bound input size.
function parseBulkNames(input, options = {}) {
  const lineLimit = Number.isInteger(options.lineLimit) && options.lineLimit > 0
    ? options.lineLimit
    : 1000;

  if (typeof input !== "string") {
    return { names: [], errors: [{ line: 0, message: "Input must be a string." }] };
  }

  const errors = [];
  const names = [];
  let stripped = input;
  if (stripped.startsWith(UTF8_BOM)) {
    stripped = stripped.slice(1);
  }

  let i = 0;
  let line = 1;
  let field = "";
  let inQuotes = false;
  let firstColumnOfRow = true;
  const maxLength = stripped.length;

  function pushField() {
    const trimmed = field.trim();
    if (firstColumnOfRow) {
      if (trimmed.length > 0) {
        names.push(trimmed);
      }
    }
    field = "";
  }

  while (i < maxLength) {
    if (line > lineLimit) {
      errors.push({ line, message: `Bulk input exceeded ${lineLimit} rows.` });
      break;
    }
    const ch = stripped[i];

    if (inQuotes) {
      if (ch === "\"") {
        if (stripped[i + 1] === "\"") {
          field += "\"";
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === "\"") {
      if (field.length > 0) {
        errors.push({ line, message: "Unexpected quote after unquoted field." });
        return { names: [], errors };
      }
      inQuotes = true;
      i += 1;
      continue;
    }

    if (ch === ",") {
      pushField();
      // After the first column on this row, ignore subsequent columns.
      firstColumnOfRow = false;
      i += 1;
      continue;
    }

    if (ch === "\r") {
      pushField();
      line += 1;
      firstColumnOfRow = true;
      if (stripped[i + 1] === "\n") {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (ch === "\n") {
      pushField();
      line += 1;
      firstColumnOfRow = true;
      i += 1;
      continue;
    }

    field += ch;
    i += 1;
  }

  if (inQuotes) {
    errors.push({ line, message: "Unbalanced quote in bulk input." });
    return { names: [], errors };
  }

  // Final field at EOF.
  if (field.length > 0 || (i > 0 && (stripped[i - 1] === "," || firstColumnOfRow))) {
    pushField();
  }

  return { names, errors };
}

module.exports = {
  buildCsv,
  escapeField,
  parseBulkNames,
  UTF8_BOM,
  CRLF
};
