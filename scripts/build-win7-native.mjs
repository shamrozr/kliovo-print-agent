import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT, verifyWindowsBinary } from "./build-win7.mjs";

const zig = process.env.KLIOVO_ZIG || "zig";
function run(args) {
  const result = spawnSync(zig, args, { cwd: ROOT, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
if (run(["version"]) !== "0.13.0") throw new Error("Rebuild the native helpers with Zig 0.13.0");
const zigLib = JSON.parse(run(["env"])).lib_dir;
const directory = path.join(ROOT, "legacy", "win7", "native");
const source = path.join(directory, "rawprint.c");
const metadata = { compiler: "Zig 0.13.0 (freestanding C, no CRT)", sourceSha256: createHash("sha256").update(await readFile(source)).digest("hex"), binaries: {} };
for (const [arch, target] of [["ia32", "x86-windows.win7-gnu"], ["x64", "x86_64-windows.win7-gnu"]]) {
  const output = path.join(directory, "bin", arch, "kliovo-rawprint.exe");
  await mkdir(path.dirname(output), { recursive: true });
  run(["cc", "-target", target, "-std=c99", "-Os", "-s", "-ffreestanding", "-fno-stack-protector", "-nostdlib", "-Werror",
    "-isystem", path.join(zigLib, "libc", "include", "any-windows-any"), source,
    "-lkernel32", "-lwinspool", "-lshell32", "-Wl,--entry=mainCRTStartup", "-Wl,--subsystem,console", "-o", output]);
  const bytes = await readFile(output);
  verifyWindowsBinary(bytes, arch);
  metadata.binaries[arch] = createHash("sha256").update(bytes).digest("hex");
  console.log(`Built direct Windows ${arch} spooler helper (${bytes.length} bytes)`);
}
await writeFile(path.join(directory, "checksums.json"), JSON.stringify(metadata, null, 2) + "\n");
