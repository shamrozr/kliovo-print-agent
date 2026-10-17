import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY = path.join(ROOT, "legacy", "win7");
export const ELECTRON_VERSION = "22.3.27";
export const SQLITE_VERSION = "9.5.0";
const PREBUILDS = {
  ia32: { machine: 0x014c, sha256: "6adb59ffe2565453b8c7a39c99e05149aab7d4fe67e2073d80c0e4429e95c0e7" },
  x64: { machine: 0x8664, sha256: "99a7b76f06e9ed6ac344c94b51da6165a1e1a5f3067942bbf89c0365c08b8bca" },
};

export function parseOptions(args) {
  const options = { arches: ["ia32", "x64"], prepareOnly: false, skipExeEdit: false };
  for (const arg of args) {
    if (arg === "--prepare-only") options.prepareOnly = true;
    else if (arg === "--skip-exe-edit") options.skipExeEdit = true;
    else if (arg.startsWith("--arch=")) {
      const arch = arg.slice(7);
      if (!Object.hasOwn(PREBUILDS, arch)) throw new Error(`Unsupported Windows 7 architecture: ${arch}`);
      options.arches = [arch];
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

export function verifyWindowsBinary(bytes, arch) {
  if (!Object.hasOwn(PREBUILDS, arch)) throw new Error(`Unsupported architecture: ${arch}`);
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") throw new Error("Not a Windows PE binary");
  const pe = bytes.readUInt32LE(0x3c);
  if (pe + 24 + 52 > bytes.length || bytes.toString("ascii", pe, pe + 4) !== "PE\0\0") {
    throw new Error("Invalid Windows PE header");
  }
  if (bytes.readUInt16LE(pe + 4) !== PREBUILDS[arch].machine) throw new Error(`Windows binary architecture does not match ${arch}`);
  // A matching ABI alone cannot detect an accidentally rebuilt Win10-only binary.
  for (const offset of [40, 48]) {
    const major = bytes.readUInt16LE(pe + 24 + offset);
    const minor = bytes.readUInt16LE(pe + 24 + offset + 2);
    if (major > 6 || (major === 6 && minor > 1)) throw new Error(`PE header requires Windows ${major}.${minor}, later than Windows 7`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} exited with status ${result.status}`);
}

export async function prepareBuild(arch) {
  if (!Object.hasOwn(PREBUILDS, arch)) throw new Error(`Unsupported architecture: ${arch}`);
  const stage = path.join(ROOT, ".legacy-win7", arch);
  // Only remove this architecture's generated build tree, never mainline outputs.
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  for (const entry of ["dist", "assets"]) await cp(path.join(ROOT, entry), path.join(stage, entry), { recursive: true });
  const settings = path.join(stage, "src", "windows", "settings");
  await mkdir(settings, { recursive: true });
  for (const entry of ["index.html", "renderer.js"]) {
    await cp(path.join(ROOT, "src", "windows", "settings", entry), path.join(settings, entry));
  }
  for (const entry of ["legacy-main.cjs", "legacy-runtime.cjs", "package-lock.json", "package.json"]) {
    await cp(path.join(LEGACY, entry), path.join(stage, entry));
  }
  const manifest = JSON.parse(await readFile(path.join(stage, "package.json"), "utf8"));
  const helperMetadata = JSON.parse(await readFile(path.join(LEGACY, "native", "checksums.json"), "utf8"));
  const helperSource = await readFile(path.join(LEGACY, "native", "rawprint.c"));
  const helper = await readFile(path.join(LEGACY, "native", "bin", arch, "kliovo-rawprint.exe"));
  if (createHash("sha256").update(helperSource).digest("hex") !== helperMetadata.sourceSha256 ||
      createHash("sha256").update(helper).digest("hex") !== helperMetadata.binaries[arch]) {
    throw new Error("Native print helper source/binary changed: rebuild with scripts/build-win7-native.mjs");
  }
  verifyWindowsBinary(helper, arch);
  await mkdir(path.join(stage, "native"));
  await writeFile(path.join(stage, "native", "kliovo-rawprint.exe"), helper);
  const modern = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  // The independent manifest owns the legacy prerelease number; do not silently
  // rebuild stale application sources under another application's version.
  if (!manifest.version.startsWith(`${modern.version}-win7.`)) {
    throw new Error("Update legacy/win7/package.json and its lockfile to match the mainline app version");
  }
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: stage,
    // Windows npm is a command script; all arguments here are fixed literals.
    shell: process.platform === "win32",
  });

  const filename = `better-sqlite3-multiple-ciphers-v${SQLITE_VERSION}-electron-v110-win32-${arch}.tar.gz`;
  const url = `https://github.com/m4heshd/better-sqlite3-multiple-ciphers/releases/download/v${SQLITE_VERSION}/${filename}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Native module download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== PREBUILDS[arch].sha256) {
    throw new Error(`Checksum mismatch for ${filename}`);
  }
  const archivePath = path.join(stage, filename);
  await writeFile(archivePath, archive);
  const moduleDir = path.join(stage, "node_modules", "better-sqlite3-multiple-ciphers");
  run("tar", ["-xzf", archivePath, "-C", moduleDir, "build/Release/better_sqlite3.node"]);
  await rm(archivePath);
  verifyWindowsBinary(await readFile(path.join(moduleDir, "build", "Release", "better_sqlite3.node")), arch);
  console.log(`Prepared Windows 7 ${arch}: Electron ${ELECTRON_VERSION}, SQLite ${SQLITE_VERSION} (ABI 110)`);
  return stage;
}

export async function verifyPackage(output, stage, arch) {
  const unpacked = path.join(output, arch === "ia32" ? "win-ia32-unpacked" : "win-unpacked");
  verifyWindowsBinary(await readFile(path.join(unpacked, "Kliovo Print Agent Win7.exe")), arch);
  const resources = path.join(unpacked, "resources");
  const printHelper = await readFile(path.join(resources, "kliovo-rawprint.exe"));
  verifyWindowsBinary(printHelper, arch);
  if (!printHelper.equals(await readFile(path.join(stage, "native", "kliovo-rawprint.exe")))) throw new Error("Packaged native printer helper differs");
  const asar = require("@electron/asar");
  const archive = path.join(resources, "app.asar");
  const metadata = JSON.parse(asar.extractFile(archive, "package.json").toString());
  if (metadata.kliovoBuildTarget !== "win7" || metadata.main !== "legacy-main.cjs") {
    throw new Error("Packaged app does not use the isolated Windows 7 entry point");
  }
  if (metadata.dependencies["better-sqlite3-multiple-ciphers"] !== SQLITE_VERSION) throw new Error("Unexpected packaged SQLite version");
  for (const entry of ["legacy-main.cjs", "legacy-runtime.cjs", "dist/main.js", "dist/updater.js", "dist/system-printer.js", "src/windows/settings/index.html", "src/windows/settings/renderer.js"]) {
    // ASAR traverses nested archive paths using the host's path separator.
    if (!asar.extractFile(archive, path.normalize(entry)).equals(await readFile(path.join(stage, entry)))) throw new Error(`Packaged file differs: ${entry}`);
  }
  const native = path.join("node_modules", "better-sqlite3-multiple-ciphers", "build", "Release", "better_sqlite3.node");
  const packagedNative = await readFile(path.join(resources, "app.asar.unpacked", native));
  verifyWindowsBinary(packagedNative, arch);
  if (!packagedNative.equals(await readFile(path.join(stage, native)))) throw new Error("Packager replaced the pinned SQLite binary");
  console.log(`Verified packaged Windows 7 ${arch} executable, runtime entry point and native module`);
  return unpacked;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const config = require("js-yaml").load(await readFile(path.join(LEGACY, "electron-builder.yml"), "utf8"));
  if (config.electronVersion !== ELECTRON_VERSION || config.win.target !== "nsis" || config.npmRebuild !== false || config.publish !== null) {
    throw new Error("Legacy builder must pin Electron, select architecture via CLI, preserve native prebuilds and disable publishing");
  }
  for (const arch of options.arches) {
    const stage = await prepareBuild(arch);
    if (options.prepareOnly) continue;
    const output = path.join(ROOT, "release", "win7", arch);
    await rm(output, { recursive: true, force: true });
    const args = [require.resolve("electron-builder/cli.js"), "--projectDir", stage, "--config", path.join(LEGACY, "electron-builder.yml"), "--win", `--${arch}`, "--publish", "never", `--config.directories.output=${output}`];
    if (options.skipExeEdit) args.push("--config.win.signAndEditExecutable=false");
    run(process.execPath, args);
    const unpacked = await verifyPackage(output, stage, arch);
    if (process.platform === "win32") {
      run(path.join(unpacked, "Kliovo Print Agent Win7.exe"), [path.join(LEGACY, "smoke.cjs"), stage], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
