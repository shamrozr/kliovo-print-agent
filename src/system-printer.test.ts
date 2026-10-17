/**
 * Printer enumeration must survive old Windows boxes where WMI is broken or
 * PowerShell is missing, but the spooler (and therefore printing) is fine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

type Handler = (cmd: string, args: string[]) => { err?: Error; stdout?: string; stderr?: string };

let handler: Handler = () => ({ stdout: "" });
const calls: Array<{ cmd: string; args: string[]; options: { timeout: number; windowsHide: boolean } }> = [];

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("child_process", () => ({
  execFile: (cmd: string, args: string[], options: { timeout: number; windowsHide: boolean }, cb: Function) => {
    calls.push({ cmd, args, options });
    const r = handler(cmd, args);
    setImmediate(() => cb(r.err ?? null, r.stdout ?? "", r.stderr ?? ""));
  },
}));

const realPlatform = process.platform;
const realResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
function setPlatform(p: string) {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

async function freshModule() {
  vi.resetModules();
  return import("./system-printer");
}

beforeEach(() => {
  calls.length = 0;
  handler = () => ({ stdout: "" });
});

afterEach(() => {
  setPlatform(realPlatform);
  if (realResourcesPath) Object.defineProperty(process, "resourcesPath", realResourcesPath);
  else Reflect.deleteProperty(process, "resourcesPath");
});

describe("listSystemPrinters — windows", () => {
  beforeEach(() => setPlatform("win32"));

  it("parses PowerShell output, trimming and de-duplicating", async () => {
    handler = () => ({ stdout: "XP-58\r\n  POS-80  \r\nXP-58\r\n\r\n" });
    const { listSystemPrinters } = await freshModule();

    expect(await listSystemPrinters()).toEqual(["XP-58", "POS-80"]);
    expect(calls[0].cmd).toBe("powershell.exe");
  });

  it("falls back to the spooler registry when PowerShell is broken", async () => {
    handler = (cmd) =>
      cmd === "powershell.exe"
        ? { err: new Error("'powershell.exe' is not recognized") }
        : {
            stdout:
              "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers\\XP-58\r\n" +
              "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers\\Microsoft XPS Document Writer\r\n",
          };
    const { listSystemPrinters } = await freshModule();

    expect(await listSystemPrinters()).toEqual(["XP-58", "Microsoft XPS Document Writer"]);
    expect(calls.map((c) => c.cmd)).toEqual(["powershell.exe", "reg.exe"]);
  });

  it("falls back to the registry when PowerShell succeeds but finds nothing", async () => {
    handler = (cmd) =>
      cmd === "powershell.exe"
        ? { stdout: "\r\n" }
        : { stdout: "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers\\XP-58\r\n" };
    const { listSystemPrinters } = await freshModule();

    expect(await listSystemPrinters()).toEqual(["XP-58"]);
  });

  it("keeps the last known list when a later scan comes back empty", async () => {
    handler = () => ({ stdout: "XP-58\r\n" });
    const { listSystemPrinters } = await freshModule();
    expect(await listSystemPrinters()).toEqual(["XP-58"]);

    // Spooler restarting / WMI hiccup — the picker must not go blank.
    handler = () => ({ err: new Error("spooler unavailable") });
    expect(await listSystemPrinters()).toEqual(["XP-58"]);
  });

  it("returns an empty list when nothing has ever been detected", async () => {
    handler = () => ({ err: new Error("nope") });
    const { listSystemPrinters } = await freshModule();

    expect(await listSystemPrinters()).toEqual([]);
  });
});

describe("sendRawToSystemPrinter — windows", () => {
  beforeEach(() => setPlatform("win32"));

  it("uses the packaged native helper directly without starting PowerShell", async () => {
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), "kliovo-native-test-"));
    const executable = path.join(resources, "kliovo-rawprint.exe");
    fs.writeFileSync(executable, "test fixture; execution is mocked");
    Object.defineProperty(process, "resourcesPath", { value: resources, configurable: true });
    try {
      const { sendRawToSystemPrinter } = await freshModule();
      await sendRawToSystemPrinter("Star TSP143IIIW Cutter", Buffer.from("receipt"));
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe(executable);
      expect(calls[0].args[0]).toBe("Star TSP143IIIW Cutter");
      expect(calls[0].args).toHaveLength(2);
      expect(calls[0].options).toEqual({ timeout: 15_000, windowsHide: true });
    } finally {
      fs.rmSync(resources, { recursive: true, force: true });
    }
  });

  it("does not start a PowerShell fallback after an uncertain native helper timeout", async () => {
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), "kliovo-native-test-"));
    fs.writeFileSync(path.join(resources, "kliovo-rawprint.exe"), "test fixture");
    Object.defineProperty(process, "resourcesPath", { value: resources, configurable: true });
    handler = () => ({ err: Object.assign(new Error("Command failed"), { killed: true }) });
    try {
      const { sendRawToSystemPrinter } = await freshModule();
      await expect(sendRawToSystemPrinter("Star", Buffer.from("receipt"))).rejects.toThrow(/timed out after 15 seconds/);
      expect(calls).toHaveLength(1);
      expect(calls[0].cmd).toBe(path.join(resources, "kliovo-rawprint.exe"));
    } finally {
      fs.rmSync(resources, { recursive: true, force: true });
    }
  });

  it("embeds the bad-port guard in the script it writes to disk", async () => {
    const fs = await import("fs");
    handler = () => ({ stdout: "" });
    const { sendRawToSystemPrinter } = await freshModule();

    await sendRawToSystemPrinter("XP-58", Buffer.from("hi"));

    const scriptPath = calls[0].args[calls[0].args.indexOf("-File") + 1];
    const written = fs.readFileSync(scriptPath, "utf-8");
    expect(written).toContain("Get-Printer -Name $PrinterName");
    expect(written).toContain("save to a file instead of printing");
    expect(written.charCodeAt(0)).toBe(0xfeff);
    expect(written).toContain("[Console]::Error.WriteLine");
    expect(calls[0].options).toEqual({ timeout: 60_000, windowsHide: true });
  });

  it("surfaces the bad-port message when the spooler refuses to print", async () => {
    // execFile's err path prefers stderr — simulate PowerShell's
    // Write-Error -ErrorAction Stop (the bad-port guard) landing on stderr.
    handler = () => ({
      err: new Error("command failed"),
      stderr:
        "Printer 'XP-58' is set to save to a file instead of printing (port='C:\\Users\\till\\Documents').",
    });
    const { sendRawToSystemPrinter } = await freshModule();

    await expect(sendRawToSystemPrinter("XP-58", Buffer.from("hi"))).rejects.toThrow(
      /set to save to a file instead of printing/
    );
    expect(calls).toHaveLength(1);
  });

  it("reports a compilation timeout and does not blindly submit a second job", async () => {
    handler = () => ({
      err: Object.assign(new Error("Command failed: powershell.exe ..."), { killed: true, signal: "SIGTERM" }),
      stdout: "KLIOVO_PRINT_PHASE:checking the printer\r\nKLIOVO_PRINT_PHASE:compiling printer support\r\n",
    });
    const { sendRawToSystemPrinter } = await freshModule();
    await expect(sendRawToSystemPrinter("XP-58", Buffer.from("hi"))).rejects.toThrow(
      /timed out after 60 seconds while compiling printer support/
    );
    expect(calls).toHaveLength(1);
  });

  it("identifies a PowerShell startup timeout when no script output arrived", async () => {
    handler = () => ({ err: Object.assign(new Error("Command failed"), { killed: true }) });
    const { sendRawToSystemPrinter } = await freshModule();
    await expect(sendRawToSystemPrinter("XP-58", Buffer.from("hi"))).rejects.toThrow(/while starting the Windows print helper/);
    expect(calls).toHaveLength(1);
  });

  it("preserves errors returned on stdout without exposing progress markers", async () => {
    handler = () => ({
      err: new Error("Command failed: powershell.exe ..."),
      stdout: "KLIOVO_PRINT_PHASE:compiling printer support\r\nAdd-Type: compiler could not be started\r\n",
    });
    const { sendRawToSystemPrinter } = await freshModule();
    await expect(sendRawToSystemPrinter("XP-58", Buffer.from("hi"))).rejects.toThrow(/^Add-Type: compiler could not be started$/);
    expect(calls).toHaveLength(1);
  });

  it("explains access denied and does not retry a permanent failure", async () => {
    handler = () => ({ err: new Error("Command failed"), stderr: "OpenPrinter failed (5)" });
    const { sendRawToSystemPrinter } = await freshModule();
    await expect(sendRawToSystemPrinter("XP-58", Buffer.from("hi"))).rejects.toThrow(/Access denied/);
    expect(calls).toHaveLength(1);
  });

  it("retries a known transient StartDocPrinter failure before any bytes are written", async () => {
    handler = () => calls.length === 1
      ? { err: new Error("Command failed"), stderr: "StartDocPrinter failed (1905)" }
      : { stdout: "" };
    const { sendRawToSystemPrinter } = await freshModule();
    await sendRawToSystemPrinter("XP-58", Buffer.from("hi"));
    expect(calls).toHaveLength(2);
  });

  it("does not retry WritePrinter errors because bytes may already have printed", async () => {
    handler = () => ({ err: new Error("Command failed"), stderr: "WritePrinter failed (1722)" });
    const { sendRawToSystemPrinter } = await freshModule();
    await expect(sendRawToSystemPrinter("XP-58", Buffer.from("hi"))).rejects.toThrow(/WritePrinter failed/);
    expect(calls).toHaveLength(1);
  });
});

describe("listSystemPrinters — cups", () => {
  beforeEach(() => setPlatform("darwin"));

  it("reads queue names from lpstat -e", async () => {
    handler = () => ({ stdout: "POSpro\nPrinter_POS_80\n" });
    const { listSystemPrinters } = await freshModule();

    expect(await listSystemPrinters()).toEqual(["POSpro", "Printer_POS_80"]);
    expect(calls[0]).toMatchObject({ cmd: "lpstat", args: ["-e"] });
  });
});
