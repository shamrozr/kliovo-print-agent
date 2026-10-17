# Windows 7 legacy builds

This target packages the current agent source for **Windows 7 SP1, 32-bit (ia32)
and 64-bit (x64)** using Electron 22.3.27. It is a separate application called
**Kliovo Print Agent Win7**, with version `2.14.0-win7.1` for the first build.

Electron 22 is the last Electron line supporting Windows 7 and is out of support.
These installers require qualification on actual Windows 7 SP1 machines before
deployment. Successful packaging or execution on a modern Windows build host
does not establish Windows 7 printer/driver compatibility.

## Installers

- `release/win7/ia32/Kliovo-Print-Agent-Win7-2.14.0-win7.1-ia32-Setup.exe`
- `release/win7/x64/Kliovo-Print-Agent-Win7-2.14.0-win7.1-x64-Setup.exe`

Use ia32 for 32-bit Windows and x64 for 64-bit Windows. Install the printer's
Windows 7 driver and confirm its Windows test page works before testing the
agent. Close any other Kliovo agent before starting the legacy one: both use the
same local bridge port, so only one should run on a machine.

The legacy agent has its own app ID, installation, shortcut, and data directory:
`%APPDATA%\Kliovo Print Agent Win7`. Pair it and configure its printers after
installation. It does not import or downgrade the modern agent's encrypted
database. Do not copy a modern database into this folder without a separately
verified migration; the two SQLite encryption-library versions differ.

Automatic updates are disabled for the legacy application. Install subsequent
**Win7** installers manually. The legacy application never checks the modern
fleet's update endpoint, and the build workflow does not publish releases or
update metadata. A separate server update channel would be needed to enable
automatic legacy updates later.

## Build locally

Use a modern build host with **Node 22 or later**, npm, pnpm 9.15.9, and `tar`.
Windows Server 2022, used by the workflow, includes `tar`. Node is bundled with
the finished application; it does not need to be installed on the Windows 7 till.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm test:win7
pnpm dist:win7
```

Build one architecture with `pnpm dist:win7 --arch=ia32` or
`pnpm dist:win7 --arch=x64`. Both are built when no architecture is specified.
To prepare isolated dependencies and native modules without packaging, run
`pnpm prepare:win7`.

On a Mac without Wine, `pnpm dist:win7 --skip-exe-edit` can cross-build candidate
installers. This skips editing the embedded executable's icon/version resources;
the Windows workflow performs normal executable editing. These local candidates
are for testing and are not signed or published by this workflow.

The script creates an independent `.legacy-win7/<arch>` application directory.
It installs the legacy `package-lock.json` with `npm ci --ignore-scripts`, then
downloads the matching SQLite Electron ABI 110 Windows prebuild. Download
checksums, PE architecture, and the declared Windows OS/subsystem version are
checked. Native rebuilding is disabled so modern build tools cannot silently
replace this binary. Mainline dependencies and `pnpm-lock.yaml` are unchanged.

The legacy manifest and its lockfile own the prerelease version. When mainline
version changes, update the legacy version to `<mainline-version>-win7.<n>` and
refresh the legacy lockfile explicitly:

```sh
npm install --package-lock-only --ignore-scripts --prefix legacy/win7
```

The runtime uses `node-fetch` 2.7.0 only if global fetch is missing. Electron
22's Node 16.17.1 already has `AbortSignal.timeout`. The shim and legacy data path
are initialized before importing agent services.

## Windows workflow and checks

Run **Build Windows 7 Legacy** manually from GitHub Actions after the changes
are pushed. Its independent ia32/x64 jobs upload installer artifacts without
creating a GitHub release or touching the normal release workflow.

The build verifies the packaged executable architecture, legacy entry point,
settings files, updater code, and exact unpacked native module bytes. On a
Windows build host, it also runs the packaged Electron executable in Node mode
without opening any windows to exercise:

- Electron version and native ABI.
- HTTP authentication, request/response JSON, redirects, polling headers,
  timeout cancellation, and already-aborted requests.
- Encrypted SQLite, creation of the full offline schema, persistence across
  reopening, integrity checks, and rejection of the wrong encryption key.

`pnpm test:win7` checks update isolation, unchanged modern update behavior,
initialization of separate storage before imports, and rejection of malformed,
wrong-architecture, or newer-Windows PE binaries.

## Windows 7 qualification still required

On **both** 32-bit and 64-bit Windows 7 SP1, verify installation, startup,
pairing, server communication, printer enumeration, an actual USB receipt,
network printing where used, restart/recovery, and offline operation where
enabled. Verify any deployed label printers, cash drawers, attendance devices,
and tax-relay features before relying on them at a till. Printer or settings
screen inspection still requires the user's explicit permission.

The PE checks do not prove that every DLL import, Windows update prerequisite,
PowerShell/.NET installation, device driver, or TLS certificate chain works on
the target machine. Keep the installers as test candidates until these checks
have passed.

## Upstream references

- [Electron Windows 7 support notice](https://www.electronjs.org/blog/windows-7-to-8-1-deprecation-notice)
- [Electron 22.3.27](https://releases.electronjs.org/release/v22.3.27)
- [Encrypted SQLite 9.5.0 and its Electron 22 x86/x64 prebuilds](https://github.com/m4heshd/better-sqlite3-multiple-ciphers/releases/tag/v9.5.0)
- [Node 16 globals and AbortSignal.timeout](https://nodejs.org/download/release/v16.20.2/docs/api/globals.html)
