/**
 * System (USB) printer delivery — send RAW ESC/POS bytes to a printer that
 * is installed through the operating system's print queue rather than reached
 * over TCP. This is how USB thermal printers are addressed.
 *
 * No native module: we drive the OS spooler through tools that ship with the
 * platform, so the electron-builder pipeline stays plain `tsc` + asar.
 *
 *   Windows — PowerShell P/Invokes winspool.drv (OpenPrinter →
 *             StartDocPrinter "RAW" → WritePrinter). Reuses the driver the
 *             user installed when they plugged the printer in. Offline-safe.
 *             Checks the queue's port before writing — see BAD_PORT_CHECK_PS1.
 *   macOS   — `lp -d <queue> -o raw` (CUPS).
 *   Linux   — `lp -d <queue> -o raw` (CUPS).
 */
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { logger } from "./logger";

const SPOOL_TIMEOUT_MS = 15_000;
// Enumeration gets a longer budget: on old hardware (Core 2 Duo + spinning
// disk) a cold PowerShell start alone can eat 10-15s before it runs anything.
const ENUM_TIMEOUT_MS = 30_000;

/**
 * Windows silently redirects a raw print job to disk when a queue's port has
 * been reassigned to a file path instead of the printer's real USB/local port
 * (a "Local Port" pointing at e.g. C:\...\Documents\<queue name>, or the
 * literal FILE: port) — WritePrinter still reports success, so nothing here
 * ever sees a failure; the operator just finds a growing pile of files named
 * after the printer in Documents. This is what a Bixolon queue does whenever
 * its USB connection is re-enumerated on a new port and the driver doesn't
 * re-bind cleanly. Refuse BEFORE writing instead of silently saving another
 * file, so it fails loudly and the operator has something actionable.
 */
const BAD_PORT_CHECK_PS1 = `
try {
  $p = Get-Printer -Name $PrinterName -ErrorAction Stop
  if ($p.PortName -match '^[A-Za-z]:\\\\' -or $p.PortName -eq 'FILE:') {
    Write-Error "Printer '$PrinterName' is set to save to a file instead of printing (port='$($p.PortName)'). Open Windows Settings > Printers & scanners > $PrinterName > Printer properties > Ports, and point it back at the printer's real USB port, then try again." -ErrorAction Stop
  }
} catch {
  if ($_.Exception.Message -like "*save to a file instead*") { throw }
  # Get-Printer itself unavailable/broken (old Windows, WMI hiccup) — this is a
  # diagnostic, not the primary path; do not block printing on it failing.
}
`;

/** C# RawPrinterHelper compiled in-process by PowerShell via Add-Type. */
const RAW_PRINT_PS1 = `param([Parameter(Mandatory=$true)][string]$PrinterName,[Parameter(Mandatory=$true)][string]$FilePath)
$ErrorActionPreference = "Stop"
${BAD_PORT_CHECK_PS1}
$code = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public class DOCINFOW {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.Drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode, ExactSpelling=true)]
  public static extern bool OpenPrinter(string src, out IntPtr hPrinter, IntPtr pd);
  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true, ExactSpelling=true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode, ExactSpelling=true)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, Int32 level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFOW di);
  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true, ExactSpelling=true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true, ExactSpelling=true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true, ExactSpelling=true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);
  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true, ExactSpelling=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, Int32 dwCount, out Int32 dwWritten);
  public static void SendBytes(string printerName, byte[] bytes) {
    IntPtr hPrinter;
    if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
      throw new Exception("OpenPrinter failed (" + Marshal.GetLastWin32Error() + ") for '" + printerName + "'");
    try {
      DOCINFOW di = new DOCINFOW();
      di.pDocName = "Kliovo Print Agent";
      di.pDataType = "RAW";
      if (!StartDocPrinter(hPrinter, 1, di)) throw new Exception("StartDocPrinter failed (" + Marshal.GetLastWin32Error() + ")");
      try {
        if (!StartPagePrinter(hPrinter)) throw new Exception("StartPagePrinter failed (" + Marshal.GetLastWin32Error() + ")");
        IntPtr p = Marshal.AllocCoTaskMem(bytes.Length);
        try {
          Marshal.Copy(bytes, 0, p, bytes.Length);
          int written;
          if (!WritePrinter(hPrinter, p, bytes.Length, out written))
            throw new Exception("WritePrinter failed (" + Marshal.GetLastWin32Error() + ")");
        } finally { Marshal.FreeCoTaskMem(p); }
        EndPagePrinter(hPrinter);
      } finally { EndDocPrinter(hPrinter); }
    } finally { ClosePrinter(hPrinter); }
  }
}
'@
Add-Type -TypeDefinition $code -Language CSharp
$bytes = [System.IO.File]::ReadAllBytes($FilePath)
[RawPrinterHelper]::SendBytes($PrinterName, $bytes)
`;

let cachedPs1Path: string | null = null;
function ensurePs1(): string {
  if (cachedPs1Path && fs.existsSync(cachedPs1Path)) return cachedPs1Path;
  const p = path.join(os.tmpdir(), "kliovo-rawprint.ps1");
  fs.writeFileSync(p, RAW_PRINT_PS1, "utf-8");
  cachedPs1Path = p;
  return p;
}

// Translate the raw Win32 codes the spooler throws into something a restaurant
// operator can act on, while keeping the original code for support.
function explainWin32(detail: string): string {
  const m = detail.match(/\((\d{3,5})\)/);
  const code = m ? Number(m[1]) : 0;
  const hints: Record<number, string> = {
    5: "Access denied — run the agent as the same Windows user that installed the printer.",
    1801: "Windows doesn't recognise this printer name — pick the exact name from the list.",
    1722: "The Windows Print Spooler service isn't running — start it (services.msc → Print Spooler).",
    1905: "Windows reports this printer as deleted/unavailable. Re-add the printer in Windows Settings → Printers. If it's a redirected/RDP printer it can't be used for raw printing — install the printer locally on this PC.",
  };
  return hints[code] ? `${detail} — ${hints[code]}` : detail;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: SPOOL_TIMEOUT_MS, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) {
        const detail = (stderr || "").trim() || err.message;
        return reject(new Error(explainWin32(detail)));
      }
      resolve();
    });
  });
}

/** Send RAW ESC/POS bytes to an OS print queue by its exact name. */
export async function sendRawToSystemPrinter(printerName: string, bytes: Buffer): Promise<void> {
  if (!printerName) throw new Error("systemPrinterName is required for a system printer");

  const tmpBin = path.join(os.tmpdir(), `kliovo-job-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  fs.writeFileSync(tmpBin, bytes);

  try {
    if (process.platform === "win32") {
      const psArgs = [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", ensurePs1(),
        "-PrinterName", printerName,
        "-FilePath", tmpBin,
      ];
      try {
        await run("powershell.exe", psArgs);
      } catch (e) {
        // Spooler hiccups (e.g. StartDocPrinter 1905) are often transient — retry once.
        logger.warn(`[system] raw print failed, retrying once: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 600));
        await run("powershell.exe", psArgs);
      }
    } else {
      // macOS / Linux — CUPS raw passthrough.
      await run("lp", ["-d", printerName, "-o", "raw", tmpBin]);
    }
    logger.info(`[system] sent ${bytes.length} bytes to system printer "${printerName}"`);
  } finally {
    fs.promises.unlink(tmpBin).catch(() => {});
  }
}

function lines(stdout: string): string[] {
  return Array.from(
    new Set(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean))
  );
}

/** Run a command for enumeration; never throws — returns "" when it fails. */
function tryRun(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: ENUM_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const detail = (stderr || "").trim() || err.message;
        logger.warn(`[system] printer enumeration via ${cmd} failed: ${detail}`);
        return resolve("");
      }
      resolve(stdout || "");
    });
  });
}

/**
 * Windows enumeration, cheapest-and-most-reliable first, all inside ONE
 * PowerShell process so a slow PC pays the cold-start cost only once:
 *
 *   1. System.Drawing InstalledPrinters — wraps winspool EnumPrinters, the same
 *      subsystem that actually prints. No WMI involved.
 *   2. Get-Printer — PrintManagement/MI provider.
 *   3. Get-WmiObject Win32_Printer — legacy WMI (what we used to rely on alone).
 *
 * Old Windows installs frequently have a corrupt WMI repository: the printer
 * works and test-prints fine, but Win32_Printer throws. Anchoring on winspool
 * keeps detection aligned with what we can actually print to.
 */
const ENUM_PS = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$n=@()",
  "try{Add-Type -AssemblyName System.Drawing;$n=@([System.Drawing.Printing.PrinterSettings]::InstalledPrinters)}catch{}",
  "if($n.Count -eq 0){try{$n=@(Get-Printer | Select-Object -ExpandProperty Name)}catch{}}",
  "if($n.Count -eq 0){try{$n=@(Get-WmiObject -Class Win32_Printer | Select-Object -ExpandProperty Name)}catch{}}",
  "$n | ForEach-Object { $_ }",
].join("; ");

/** Last-ditch, PowerShell-free and WMI-free: the spooler's own registry keys. */
const PRINTERS_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Print\\Printers";

// Last successful scan. A rescan that fails (spooler restarting, WMI hiccup,
// PowerShell starved on a slow PC) must not blank a picker that was working.
let lastKnownPrinters: string[] = [];

/** Enumerate OS-installed printer queue names so the UI can offer a picker. */
export async function listSystemPrinters(): Promise<string[]> {
  const found = await scanSystemPrinters();
  if (found.length) {
    lastKnownPrinters = found;
    return found;
  }
  if (lastKnownPrinters.length) {
    logger.warn("[system] printer scan came back empty — keeping the last known list");
    return lastKnownPrinters;
  }
  return [];
}

async function scanSystemPrinters(): Promise<string[]> {
  if (process.platform !== "win32") {
    // `lpstat -e` prints one queue name per line.
    return lines(await tryRun("lpstat", ["-e"]));
  }

  const ps = await tryRun("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-Command", ENUM_PS,
  ]);
  const names = lines(ps);
  if (names.length) return names;

  // PowerShell itself is missing/broken (stripped Windows builds do this) or
  // every provider failed. Read the spooler's registry keys directly — local
  // queues, which is exactly what a USB printer installs as.
  logger.warn("[system] no printers via PowerShell — falling back to the registry");
  const reg = await tryRun("reg.exe", ["query", PRINTERS_KEY]);
  const fromReg = lines(reg)
    .filter((l) => l.toUpperCase().startsWith("HKEY_"))
    .map((l) => l.slice(l.lastIndexOf("\\") + 1))
    .filter(Boolean);

  if (!fromReg.length) {
    logger.error(
      "[system] printer enumeration found nothing — the printer can still be " +
      "used by typing its exact Windows name in Settings > System Printer."
    );
  }
  return fromReg;
}
