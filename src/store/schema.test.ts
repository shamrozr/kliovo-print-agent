import { describe, it, expect } from "vitest";
import { SCHEMA_SQL, splitSqlStatements } from "./schema";

describe("splitSqlStatements", () => {
  it("produces no empty or comment-only fragments for the real schema", () => {
    const stmts = splitSqlStatements(SCHEMA_SQL);
    expect(stmts.length).toBeGreaterThan(0);
    for (const s of stmts) {
      expect(s.length).toBeGreaterThan(0);
      // Every fragment must contain at least one non-comment line — a
      // comment-only fragment is exactly what crashed better-sqlite3's prepare.
      const hasStatement = s.split("\n").some((l) => {
        const t = l.trim();
        return t.length > 0 && !t.startsWith("--");
      });
      expect(hasStatement).toBe(true);
    }
  });

  it("does not split on a semicolon that lives inside a comment", () => {
    const sql = `
-- Brands (org-scoped in the cloud; mirrored offline)
CREATE TABLE brands (id TEXT PRIMARY KEY);
-- trailing note; with a semicolon
CREATE TABLE t (id TEXT);
`;
    const stmts = splitSqlStatements(sql);
    expect(stmts).toEqual([
      "CREATE TABLE brands (id TEXT PRIMARY KEY)",
      "CREATE TABLE t (id TEXT)",
    ]);
  });

  it("keeps inline comments attached to their statement", () => {
    const sql = `CREATE TABLE s (v TEXT DEFAULT '{}');`;
    expect(splitSqlStatements(sql)).toEqual(["CREATE TABLE s (v TEXT DEFAULT '{}')"]);
  });

  it("drops a trailing comment after the final statement", () => {
    const sql = `CREATE TABLE a (id TEXT);\n-- the end`;
    expect(splitSqlStatements(sql)).toEqual(["CREATE TABLE a (id TEXT)"]);
  });
});
