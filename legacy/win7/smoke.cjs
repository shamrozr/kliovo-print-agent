"use strict";

// Run without opening windows, using the packaged Electron executable as Node:
// ELECTRON_RUN_AS_NODE=1 <agent.exe> smoke.cjs <staging-directory>
const assert = require("assert").strict;
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { createRequire } = require("module");

async function main() {
  const stage = path.resolve(process.argv[2]);
  const stageRequire = createRequire(path.join(stage, "package.json"));
  const httpOnly = process.argv.includes("--http-only");
  if (!httpOnly) {
    assert.equal(process.versions.electron, "22.3.27");
    assert.equal(process.versions.modules, "110");
    assert.equal(process.platform, "win32");
  }

  // Exercise the missing-global path even if the build host has native fetch.
  globalThis.fetch = undefined;
  stageRequire("./legacy-runtime.cjs").installLegacyFetch();
  assert.equal(typeof fetch, "function");
  assert.equal(typeof AbortSignal.timeout, "function");
  const server = http.createServer((req, res) => {
    if (req.url === "/slow") return;
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/echo" });
      return res.end();
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json", "x-next-poll-ms": "5000" });
      res.end(JSON.stringify({ authorization: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") }));
    });
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${url}/echo`, {
      method: "POST",
      headers: { Authorization: "Bearer smoke-test", "Content-Type": "application/json" },
      body: JSON.stringify({ receipt: "test" }),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(response.ok, true);
    assert.equal(response.headers.get("x-next-poll-ms"), "5000");
    assert.deepEqual(await response.json(), { authorization: "Bearer smoke-test", body: '{"receipt":"test"}' });
    assert.equal((await fetch(`${url}/redirect`)).status, 200);
    await assert.rejects(fetch(`${url}/slow`, { signal: AbortSignal.timeout(50) }), { name: "AbortError" });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(fetch(`${url}/echo`, { signal: controller.signal }), { name: "AbortError" });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
  console.log("PASS: legacy HTTP authentication, JSON, redirects, response headers and aborts");
  if (httpOnly) return;

  const Database = stageRequire("better-sqlite3-multiple-ciphers");
  const { SCHEMA_SQL, splitSqlStatements } = stageRequire("./dist/store/schema.js");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kliovo-win7-smoke-"));
  const filename = path.join(temp, "encrypted.db");
  let db;
  try {
    db = new Database(filename);
    db.pragma("cipher='sqlcipher'");
    db.pragma("key='win7-smoke-test-key'");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    for (const statement of splitSqlStatements(SCHEMA_SQL)) db.prepare(statement).run();
    db.exec("CREATE TABLE legacy_smoke (value TEXT NOT NULL)");
    db.prepare("INSERT INTO legacy_smoke VALUES (?)").run("encrypted receipt survives restart");
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
    db.close();
    db = new Database(filename);
    db.pragma("cipher='sqlcipher'");
    db.pragma("key='win7-smoke-test-key'");
    assert.equal(db.prepare("SELECT value FROM legacy_smoke").get().value, "encrypted receipt survives restart");
    db.close();
    db = new Database(filename);
    db.pragma("cipher='sqlcipher'");
    db.pragma("key='wrong-key'");
    assert.throws(() => db.prepare("SELECT * FROM legacy_smoke").all());
    db.close();
    assert.notEqual(fs.readFileSync(filename).subarray(0, 16).toString(), "SQLite format 3\0");
  } finally {
    if (db && db.open) db.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(`PASS: Electron ${process.versions.electron} ${process.arch}, encrypted SQLite, full schema, reopen and wrong-key rejection`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
