/**
 * Printer enumeration must survive old Windows boxes where WMI is broken or
 * PowerShell is missing, but the spooler (and therefore printing) is fine.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Handler = (cmd: string, args: string[]) => { err?: Error; stdout?: string; stderr?: string };

let handler: Handler = () => ({ stdout: "" });
const calls: Array<{ cmd: string; args: string[] }> = [];

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("child_process", () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: Function) => {
    calls.push({ cmd, args });
    const r = handler(cmd, args);
    setImmediate(() => cb(r.err ?? null, r.stdout ?? "", r.stderr ?? ""));
  },
}));

const realPlatform = process.platform;
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

afterEach(() => setPlatform(realPlatform));

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

  it("embeds the bad-port guard in the script it writes to disk", async () => {
    const fs = await import("fs");
    handler = () => ({ stdout: "" });
    const { sendRawToSystemPrinter } = await freshModule();

    await sendRawToSystemPrinter("XP-58", Buffer.from("hi"));

    const scriptPath = calls[0].args[calls[0].args.indexOf("-File") + 1];
    const written = fs.readFileSync(scriptPath, "utf-8");
    expect(written).toContain("Get-Printer -Name $PrinterName");
    expect(written).toContain("save to a file instead of printing");
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
  });
});

describe("listSystemPrinters — cups", () => {
  beforeEach(() => setPlatform("darwin"));

  it("reads queue names from lpstat -e", async () => {
    handler = () => ({ stdout: "POSpro\nPrinter_POS_80\n" });
    const { listSystemPrinters } = await freshModule();

    expect(await listSystemPrinters()).toEqual(["POSpro", "Printer_POS_80"]);
    expect(calls[0]).toEqual({ cmd: "lpstat", args: ["-e"] });
  });
});
