"use strict";

const {
  buildCsv,
  escapeField,
  parseBulkNames,
  UTF8_BOM,
  CRLF
} = require("../lib/csv-format");

describe("escapeField", () => {
  test("returns empty string for null and undefined", () => {
    expect(escapeField(null)).toBe("");
    expect(escapeField(undefined)).toBe("");
  });

  test("returns empty string for empty string", () => {
    expect(escapeField("")).toBe("");
  });

  test("passes through simple values without special chars", () => {
    expect(escapeField("hello")).toBe("hello");
    expect(escapeField("abc123")).toBe("abc123");
    expect(escapeField(42)).toBe("42");
  });

  test("wraps value containing comma in quotes", () => {
    expect(escapeField("a,b")).toBe('"a,b"');
  });

  test("wraps value containing double-quote and doubles internal quotes", () => {
    expect(escapeField('say "hello"')).toBe('"say ""hello"""');
  });

  test("wraps value containing CRLF", () => {
    expect(escapeField("line1\r\nline2")).toBe('"line1\r\nline2"');
  });

  test("wraps value containing newline", () => {
    expect(escapeField("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("buildCsv", () => {
  test("returns empty string for empty rows", () => {
    expect(buildCsv([])).toBe("");
  });

  test("returns BOM only when bom option is set and rows is empty", () => {
    expect(buildCsv([], { bom: true })).toBe(UTF8_BOM);
  });

  test("returns empty string for null input", () => {
    expect(buildCsv(null)).toBe("");
  });

  test("builds single row", () => {
    const result = buildCsv([["a", "b", "c"]]);
    expect(result).toBe("a,b,c" + CRLF);
  });

  test("builds multiple rows", () => {
    const rows = [
      ["name", "age"],
      ["Alice", "30"],
      ["Bob", "25"]
    ];
    const result = buildCsv(rows);
    expect(result).toBe("name,age" + CRLF + "Alice,30" + CRLF + "Bob,25" + CRLF);
  });

  test("escapes fields with special characters", () => {
    const result = buildCsv([['hello, world', 'say "hi"', "normal"]]);
    expect(result).toBe('"hello, world","say ""hi""",normal' + CRLF);
  });

  test("handles non-array row as empty line", () => {
    const result = buildCsv([["a"], null, ["b"]]);
    expect(result).toBe("a" + CRLF + CRLF + "b" + CRLF);
  });

  test("prepends UTF-8 BOM when bom option is true", () => {
    const result = buildCsv([["a"]], { bom: true });
    expect(result).toBe(UTF8_BOM + "a" + CRLF);
  });
});

describe("parseBulkNames", () => {
  test("returns error for non-string input", () => {
    const result = parseBulkNames(42);
    expect(result.names).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toBe("Input must be a string.");
  });

  test("returns empty names for empty input", () => {
    const result = parseBulkNames("");
    expect(result.names).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("parses single name", () => {
    const result = parseBulkNames("Alice");
    expect(result.names).toEqual(["Alice"]);
    expect(result.errors).toEqual([]);
  });

  test("parses multiple names separated by newlines", () => {
    const result = parseBulkNames("Alice\nBob\nCharlie");
    expect(result.names).toEqual(["Alice", "Bob", "Charlie"]);
    expect(result.errors).toEqual([]);
  });

  test("handles CRLF line endings", () => {
    const result = parseBulkNames("Alice\r\nBob\r\nCharlie");
    expect(result.names).toEqual(["Alice", "Bob", "Charlie"]);
    expect(result.errors).toEqual([]);
  });

  test("strips UTF-8 BOM", () => {
    const result = parseBulkNames(UTF8_BOM + "Alice\nBob");
    expect(result.names).toEqual(["Alice", "Bob"]);
    expect(result.errors).toEqual([]);
  });

  test("trims whitespace from names", () => {
    const result = parseBulkNames("  Alice  \n  Bob  ");
    expect(result.names).toEqual(["Alice", "Bob"]);
    expect(result.errors).toEqual([]);
  });

  test("skips empty lines", () => {
    const result = parseBulkNames("Alice\n\nBob\n");
    expect(result.names).toEqual(["Alice", "Bob"]);
    expect(result.errors).toEqual([]);
  });

  test("extracts only first column from CSV data", () => {
    const result = parseBulkNames("Alice,30,Engineer\nBob,25,Designer");
    expect(result.names).toEqual(["Alice", "Bob"]);
    expect(result.errors).toEqual([]);
  });

  test("handles quoted fields", () => {
    const result = parseBulkNames('"Alice"\n"Bob"');
    expect(result.names).toEqual(["Alice", "Bob"]);
    expect(result.errors).toEqual([]);
  });

  test("handles quoted fields with embedded commas", () => {
    const result = parseBulkNames('"Smith, Alice"\n"Doe, Bob"');
    expect(result.names).toEqual(["Smith, Alice", "Doe, Bob"]);
    expect(result.errors).toEqual([]);
  });

  test("handles escaped double-quotes inside quoted field", () => {
    const result = parseBulkNames('"Alice ""The Great"""');
    expect(result.names).toEqual(['Alice "The Great"']);
    expect(result.errors).toEqual([]);
  });

  test("rejects unbalanced quotes", () => {
    const result = parseBulkNames('"Alice\nBob');
    expect(result.names).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/unbalanced quote/i);
  });

  test("rejects unexpected character after closing quote", () => {
    const result = parseBulkNames('"Alice"x');
    expect(result.names).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/unexpected character after closing quote/i);
  });

  test("rejects unexpected quote after unquoted field", () => {
    const result = parseBulkNames('Alice"');
    expect(result.names).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/unexpected quote after unquoted field/i);
  });

  test("enforces line limit", () => {
    const lines = Array.from({ length: 1001 }, (_, i) => `Name${i}`).join("\n");
    const result = parseBulkNames(lines);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/exceeded.*rows/i);
  });

  test("respects custom line limit option", () => {
    const result = parseBulkNames("Alice\nBob\nCharlie", { lineLimit: 2 });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/exceeded.*rows/i);
  });
});

describe("exports", () => {
  test("UTF8_BOM is the BOM character", () => {
    expect(UTF8_BOM).toBe("\uFEFF");
  });

  test("CRLF is carriage-return + newline", () => {
    expect(CRLF).toBe("\r\n");
  });
});
