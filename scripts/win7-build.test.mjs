import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { parseOptions, ROOT, verifyWindowsBinary } from "./build-win7.mjs";

test("default builds both architectures; unsupported targets cannot become output paths", () => {
  assert.deepEqual(parseOptions([]).arches, ["ia32", "x64"]);
  assert.deepEqual(parseOptions(["--arch=ia32", "--prepare-only"]).arches, ["ia32"]);
  assert.throws(() => parseOptions(["--arch=../../src"]), /Unsupported/);
  assert.throws(() => parseOptions(["--publish"]), /Unknown option/);
});

function pe(machine, major = 6, minor = 1) {
  const bytes = Buffer.alloc(256);
  bytes.write("MZ");
  bytes.writeUInt32LE(64, 0x3c);
  bytes.write("PE\0\0", 64);
  bytes.writeUInt16LE(machine, 68);
  for (const offset of [40, 48]) {
    bytes.writeUInt16LE(major, 64 + 24 + offset);
    bytes.writeUInt16LE(minor, 64 + 24 + offset + 2);
  }
  return bytes;
}

test("rejects the wrong native architecture, corrupt PE and newer OS floor", () => {
  verifyWindowsBinary(pe(0x014c), "ia32");
  verifyWindowsBinary(pe(0x8664), "x64");
  assert.throws(() => verifyWindowsBinary(pe(0x8664), "ia32"), /architecture/);
  assert.throws(() => verifyWindowsBinary(Buffer.from("ELF"), "x64"), /PE/);
  const truncated = pe(0x8664);
  truncated.writeUInt32LE(0xffffffff, 0x3c);
  assert.throws(() => verifyWindowsBinary(truncated, "x64"), /header/);
  assert.throws(() => verifyWindowsBinary(pe(0x8664, 6, 2), "x64"), /later than Windows 7/);
});

async function loadUpdater(legacy) {
  const calls = [];
  const updater = {
    on: (event) => calls.push(["on", event]),
    setFeedURL: (feed) => calls.push(["feed", feed]),
    checkForUpdates: () => { calls.push(["check"]); return Promise.resolve(); },
    quitAndInstall: () => calls.push(["install"]),
  };
  const exports = {};
  const deps = {
    "electron-updater": { autoUpdater: updater },
    electron: { Notification: class {}, dialog: {} },
    "./logger": { logger: { info() {}, warn() {} } },
    "./tray": { setPendingUpdate() {} },
    "./config": { loadConfig: () => { calls.push(["config"]); return { serverUrl: "https://dine.kliovo.com", printers: [{ agentKey: "test-key" }] }; } },
    "../package.json": legacy ? { kliovoBuildTarget: "win7" } : {},
  };
  vm.runInNewContext(await readFile(path.join(ROOT, "dist", "updater.js"), "utf8"), {
    exports,
    require: (name) => { assert.ok(Object.hasOwn(deps, name), `Unexpected import: ${name}`); return deps[name]; },
    setInterval: () => calls.push(["timer"]),
  });
  return { api: exports, calls, updater };
}

test("legacy builds cannot contact the modern feed or start background updates", async () => {
  const { api, calls } = await loadUpdater(true);
  api.setupAutoUpdater();
  api.installPendingUpdate();
  assert.equal(api.getPendingUpdateVersion(), null);
  assert.deepEqual(calls, []);
});

test("modern builds keep authenticated updates and consent before installation", async () => {
  const { api, calls, updater } = await loadUpdater(false);
  api.setupAutoUpdater();
  assert.equal(calls.find(([name]) => name === "feed")[1].url, "https://dine.kliovo.com/api/print-agent/update");
  assert.equal(updater.requestHeaders.Authorization, "Bearer test-key");
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.ok(calls.some(([name]) => name === "check"));
  assert.ok(calls.some(([name]) => name === "timer"));
  assert.ok(!calls.some(([name]) => name === "install"));
});

test("legacy storage and HTTP shim are configured before agent imports", async () => {
  const calls = [];
  vm.runInNewContext(await readFile(path.join(ROOT, "legacy", "win7", "legacy-main.cjs"), "utf8"), {
    require: (name) => {
      if (name === "path") return path;
      if (name === "electron") return { app: {
        getPath: () => "/appdata",
        setName: (value) => calls.push(["name", value]),
        setPath: (key, value) => calls.push([key, value]),
      } };
      if (name === "./legacy-runtime.cjs") return { installLegacyFetch: () => calls.push(["fetch"]) };
      if (name === "./dist/main.js") { calls.push(["main"]); return {}; }
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  assert.deepEqual(calls, [["name", "Kliovo Print Agent Win7"], ["userData", path.join("/appdata", "Kliovo Print Agent Win7")], ["fetch"], ["main"]]);
});
