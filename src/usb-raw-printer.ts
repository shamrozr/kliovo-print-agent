/**
 * Raw USB printer delivery — for thermal printers that are NOT installed as a
 * Windows print queue (they don't appear in Settings > Printers) but still
 * accept raw ESC/POS over USB, exactly like the vendor's own software.
 *
 * These printers bind to the OS generic USB-printer stack:
 *   Windows — usbprint.sys exposes a device interface under
 *             GUID_DEVINTERFACE_USBPRINT. We enumerate it with SetupAPI and
 *             write bytes straight to the device handle (CreateFile/WriteFile),
 *             no print queue and no vendor driver required.
 *   Linux   — the kernel usblp module exposes /dev/usb/lp0, lp1 … We write
 *             bytes directly to the node.
 *   macOS   — has no raw usblp node; USB printers there are reached through
 *             CUPS, which the "system" connection already covers.
 *
 * Same philosophy as system-printer.ts: zero native modules — we drive
 * built-in OS facilities through PowerShell P/Invoke (Windows) or plain fs
 * writes (Linux), so the electron-builder pipeline stays plain tsc + asar.
 */
import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { logger } from "./logger";

const USB_TIMEOUT_MS = 15_000;

export interface RawUsbDevice {
  /** Opaque OS device path used to address the printer (CreateFile / fs write). */
  path: string;
  /** Friendly label for the picker. */
  name: string;
}

// ── Windows: enumerate USB-printer-class device interfaces ──────────────────
const WIN_LIST_PS1 = `$ErrorActionPreference = "Stop"
$code = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class KliovoUsbEnum {
  static Guid G = new Guid("28d78fad-5a12-11d1-ae5b-0000f803a8c2");
  const int DIGCF_PRESENT = 0x2, DIGCF_DEVICEINTERFACE = 0x10;
  const int SPDRP_DEVICEDESC = 0x0, SPDRP_FRIENDLYNAME = 0xC;
  [StructLayout(LayoutKind.Sequential)] struct SP_DEVICE_INTERFACE_DATA { public int cbSize; public Guid g; public int Flags; public IntPtr Reserved; }
  [StructLayout(LayoutKind.Sequential)] struct SP_DEVINFO_DATA { public int cbSize; public Guid ClassGuid; public int DevInst; public IntPtr Reserved; }
  [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr SetupDiGetClassDevs(ref Guid g, IntPtr e, IntPtr h, int f);
  [DllImport("setupapi.dll", SetLastError=true)] static extern bool SetupDiEnumDeviceInterfaces(IntPtr h, IntPtr d, ref Guid g, int i, ref SP_DEVICE_INTERFACE_DATA da);
  [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool SetupDiGetDeviceInterfaceDetail(IntPtr h, ref SP_DEVICE_INTERFACE_DATA da, IntPtr detail, int size, ref int req, ref SP_DEVINFO_DATA info);
  [DllImport("setupapi.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool SetupDiGetDeviceRegistryProperty(IntPtr h, ref SP_DEVINFO_DATA info, int prop, out int regType, byte[] buf, int size, ref int req);
  [DllImport("setupapi.dll")] static extern bool SetupDiDestroyDeviceInfoList(IntPtr h);
  public static List<string> List() {
    var res = new List<string>();
    IntPtr h = SetupDiGetClassDevs(ref G, IntPtr.Zero, IntPtr.Zero, DIGCF_PRESENT | DIGCF_DEVICEINTERFACE);
    if (h == (IntPtr)(-1)) return res;
    try {
      SP_DEVICE_INTERFACE_DATA ifd = new SP_DEVICE_INTERFACE_DATA();
      ifd.cbSize = Marshal.SizeOf(ifd);
      int idx = 0;
      while (SetupDiEnumDeviceInterfaces(h, IntPtr.Zero, ref G, idx, ref ifd)) {
        idx++;
        int req = 0;
        SP_DEVINFO_DATA info = new SP_DEVINFO_DATA(); info.cbSize = Marshal.SizeOf(info);
        SetupDiGetDeviceInterfaceDetail(h, ref ifd, IntPtr.Zero, 0, ref req, ref info);
        if (req == 0) continue;
        IntPtr detail = Marshal.AllocHGlobal(req);
        try {
          Marshal.WriteInt32(detail, IntPtr.Size == 8 ? 8 : 6);
          info = new SP_DEVINFO_DATA(); info.cbSize = Marshal.SizeOf(info);
          if (!SetupDiGetDeviceInterfaceDetail(h, ref ifd, detail, req, ref req, ref info)) continue;
          string p = Marshal.PtrToStringUni((IntPtr)(detail.ToInt64() + 4));
          string name = "USB Printer";
          int rt; int rq = 0; byte[] buf = new byte[1024];
          if (SetupDiGetDeviceRegistryProperty(h, ref info, SPDRP_FRIENDLYNAME, out rt, buf, buf.Length, ref rq) ||
              SetupDiGetDeviceRegistryProperty(h, ref info, SPDRP_DEVICEDESC, out rt, buf, buf.Length, ref rq)) {
            string s = Encoding.Unicode.GetString(buf).TrimEnd('\\0').Trim();
            if (s.Length > 0) name = s;
          }
          res.Add(p + "\\t" + name);
        } finally { Marshal.FreeHGlobal(detail); }
      }
    } finally { SetupDiDestroyDeviceInfoList(h); }
    return res;
  }
}
'@
Add-Type -TypeDefinition $code -Language CSharp
foreach ($line in [KliovoUsbEnum]::List()) { [Console]::Out.WriteLine($line) }
`;

// ── Windows: write raw bytes to a USB device handle ─────────────────────────
const WIN_SEND_PS1 = `param([Parameter(Mandatory=$true)][string]$DevicePath,[Parameter(Mandatory=$true)][string]$FilePath)
$ErrorActionPreference = "Stop"
$code = @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public class KliovoUsbWriter {
  const uint GENERIC_WRITE = 0x40000000, OPEN_EXISTING = 3, FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2;
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr sec, uint disp, uint flags, IntPtr templ);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool WriteFile(SafeFileHandle h, byte[] buf, uint n, out uint written, IntPtr ov);
  public static void Send(string path, byte[] bytes) {
    SafeFileHandle h = CreateFile(path, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
    if (h.IsInvalid) throw new Exception("CreateFile failed (" + Marshal.GetLastWin32Error() + ") for " + path);
    using (h) {
      uint written;
      if (!WriteFile(h, bytes, (uint)bytes.Length, out written, IntPtr.Zero))
        throw new Exception("WriteFile failed (" + Marshal.GetLastWin32Error() + ")");
    }
  }
}
'@
Add-Type -TypeDefinition $code -Language CSharp
$bytes = [System.IO.File]::ReadAllBytes($FilePath)
[KliovoUsbWriter]::Send($DevicePath, $bytes)
`;

function writeTmpPs1(name: string, body: string): string {
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, body, "utf-8");
  return p;
}

function runCapture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: USB_TIMEOUT_MS, windowsHide: true }, (err, stdout) =>
      resolve(err ? "" : stdout)
    );
  });
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: USB_TIMEOUT_MS, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) return reject(new Error(((stderr || "").trim() || err.message)));
      resolve();
    });
  });
}

/** Enumerate raw-USB printers (no print queue needed) for the UI picker. */
export async function listRawUsbPrinters(): Promise<RawUsbDevice[]> {
  if (process.platform === "win32") {
    const out = await runCapture("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", writeTmpPs1("kliovo-usb-list.ps1", WIN_LIST_PS1),
    ]);
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const tab = l.indexOf("\t");
        return tab === -1
          ? { path: l, name: "USB Printer" }
          : { path: l.slice(0, tab), name: l.slice(tab + 1) || "USB Printer" };
      });
  }

  if (process.platform === "linux") {
    try {
      return fs
        .readdirSync("/dev/usb")
        .filter((f) => /^lp\d+$/.test(f))
        .map((f) => ({ path: `/dev/usb/${f}`, name: `USB Printer (${f})` }));
    } catch {
      return [];
    }
  }

  // macOS: no raw usblp node — USB printers go through CUPS ("system").
  return [];
}

/** Send RAW ESC/POS bytes straight to a USB device that has no print queue. */
export async function sendRawToUsbDevice(devicePath: string, bytes: Buffer): Promise<void> {
  if (!devicePath) throw new Error("usbDevicePath is required for a raw-USB printer");

  if (process.platform === "win32") {
    const tmpBin = path.join(os.tmpdir(), `kliovo-usb-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
    fs.writeFileSync(tmpBin, bytes);
    try {
      await run("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", writeTmpPs1("kliovo-usb-send.ps1", WIN_SEND_PS1),
        "-DevicePath", devicePath,
        "-FilePath", tmpBin,
      ]);
      logger.info(`[usb-raw] sent ${bytes.length} bytes to ${devicePath}`);
    } finally {
      fs.promises.unlink(tmpBin).catch(() => {});
    }
    return;
  }

  // Linux (and any node-addressable device): write bytes straight to the node.
  await fs.promises.writeFile(devicePath, bytes);
  logger.info(`[usb-raw] wrote ${bytes.length} bytes to ${devicePath}`);
}
