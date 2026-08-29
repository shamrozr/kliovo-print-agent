# Android Print Agent — execution plan

> Supersedes `docs/superpowers/plans/2026-06-24-android-print-agent.md`, which is
> kept for its Gradle/Compose scaffolding detail but is WRONG on the biggest
> decision: it reimplements every ESC/POS renderer in Kotlin. See "No renderers".

**Goal.** An APK that turns an Android tablet into a print agent: Dine runs in
Chrome on the same tablet, and tickets reach a **Bluetooth** thermal printer (or
a network one). Same wire protocol as the desktop agent, same exactly-once
contract.

**Decided:** online-only (no offline store, no order logic on the tablet); POS is
Dine web in Chrome/PWA talking to `127.0.0.1:6310`; lives in this repo under
`android/`.

## No renderers — the single most important scoping decision

The cloud already renders. Both delivery paths hand the agent finished bytes:
`GET /api/print/pending` answers `{ printJobId, bytesBase64 }`, and the bridge's
`POST /print` takes `bytesBase64`. So the Android agent needs **zero** ESC/POS
code: no builder, no CP-1256 table, no receipt/KOT/label templates, no Skia
raster path for Urdu.

That deletes roughly half the old plan, and it removes a whole class of bug this
codebase keeps paying for: a second implementation of one thing. A Kotlin
`ESCPOSBuilder` would drift from the TypeScript one and the same job would print
differently depending on which agent collected it — exactly the parity the
render-parity gate exists to protect.

The consequence to accept: **an Android agent cannot print during an outage**,
because nothing renders locally. That is what "online-only" means here.

## Protocol — copy the desktop agent exactly

Source of truth: `Kliovo-Dine/src/lib/print/AGENT-PROTOCOL.md` and this repo's
`src/polling.ts`. Every rule below has an incident behind it.

| Rule | Why |
|---|---|
| ACK is `PATCH /api/print/{id}` `{"action":"ack"}` **with the Bearer header** | Without it the route falls to session auth and 401s. 23,918 jobs sat at `printing` forever. |
| Ledger write **before** the ACK | The gap between paper and the ledger row is the only window a crash can duplicate. |
| `X-Agent-Dedup: 1` only when the ledger is actually usable | It is a capability claim, not a version claim. The server redelivers only to agents that send it; redelivering to one that cannot refuse a duplicate turns a lost ticket into a double print (2026-07-17, ~80 slips). |
| Never retry a 4xx (except 408/429) | A dead ACK replayed every tick pegged prod CPU on 2026-07-28. Drop it from the ledger's pending set instead. |
| NACK on delivery failure | An uncleared `printing` job is reclaimed as the OLDEST row on every later poll and head-of-line blocks every newer ticket to that printer. |
| `204` is body-less — never parse it | A body on idle crashed v2.9.x agents. |
| `X-Agent-Wait: 25` + fetch timeout 35s | Long-poll hold. The timeout must stay comfortably above the advertised wait or we abort a poll the server is still holding. |
| `X-Next-Poll-Ms` drives cadence, clamped 250…60000 | Server-driven pacing. A bad header must neither hot-loop nor silence a printer. |
| Retry ONLY a provably pre-connect failure | Anything after connect may already be on the tape. |

## Bluetooth transport

Ported from `spikes/02-bluetooth-escpos` (already Kotlin, already reasoned
through) minus the Capacitor wrapper:

- Bonded devices only (`getBondedDevices`) — pair in Android Settings, same UX
  as every cheap POS app. No BLE scan flow.
- `createRfcommSocketToServiceRecord(00001101-…)` + `connect()`, bounded by our
  own timeout (the call has none and can hang forever); `close()` on timeout is
  what actually aborts it.
- **Chunked writes, 244 bytes / 20ms.** Cheap boards have tiny buffers behind a
  slow serial bridge and drop trailing bytes *silently* rather than throwing.
  The delay is app-level back-pressure, and it is a heuristic — per-printer
  overrides exist for a reason.
- One mutex per device address: a KOT and a receipt firing together must queue,
  not interleave, or the tape is garbage.
- Outcome, never an exception: `ok` / `connect_failed` (retryable — provably
  zero bytes) / `write_failed` / `unknown` (both non-retryable). Mirrors
  `tcp-sender.ts`'s `connected` boundary.

## File map

```
android/
  settings.gradle.kts · build.gradle.kts · gradle.properties · gradle/libs.versions.toml
  app/build.gradle.kts
  app/src/main/AndroidManifest.xml
  app/src/main/res/{values,xml,drawable,mipmap-anydpi-v26}/…
  app/src/main/java/com/kliovo/printagent/
    KliovoPrintApp.kt
    config/{PrinterEntry.kt,ConfigStore.kt}
    ledger/PrintedJobsLedger.kt          printed_jobs (SQLite) + pending-ack set
    transport/{SendOutcome.kt,TcpPrinterSender.kt,BluetoothPrinterSender.kt,Deliver.kt}
    cloud/{PollPacing.kt,CloudClient.kt,PollLoop.kt}
    bridge/{IdempotencyGuard.kt,BridgeServer.kt}
    health/HealthTracker.kt
    service/{PrintAgentService.kt,BootReceiver.kt}
    ui/{MainActivity.kt,theme/Theme.kt}
  app/src/test/java/com/kliovo/printagent/…   JVM unit tests (no device needed)
.github/workflows/android.yml
```

## Phases

| # | Work | Status |
|---|---|---|
| 1 | Gradle scaffold, manifest, permissions, theme | **done** |
| 2 | Config store (printers: bluetooth \| network) + ledger | **done** |
| 3 | Transports: TCP + Bluetooth, shared outcome model | **done** |
| 4 | Cloud poll/ACK/NACK loop with pacing + dedup header | **done** |
| 5 | Foreground service, boot receiver, battery-exemption prompt | **done** |
| 6 | Local bridge on 127.0.0.1:6310 (`/ping`, `/status`, `/print`) + CORS PNA | **done** |
| 7 | Compose UI: printers, paired-device picker, test print, health | **done** |
| 8 | CI: build APK, attach to release; Dine `/downloads` product entry | **done** — APK signing secrets still unset (debug-signed until then) |

## Verified

CI run 33222088586 — unit tests pass, `assembleRelease` produces the APK. Three
real defects the local machine could not have caught, in order:

1. `SendOutcome` declared a `message` its subclasses also declared — a compile
   error, and the reason a build gate exists at all.
2. CI resolved Gradle 9.7.1 against AGP 8.5. Now pinned: an unpinned toolchain
   changes under builds that never touched it.
3. **Android's `optString` renders the `JSONObject.NULL` sentinel as the literal
   string `"null"`.** A Bluetooth printer round-tripped with `host = "null"` — a
   value that looks set, survives `isNullOrBlank`, and sends the agent to a
   hostname that does not exist. On a tablet that reads as "the printer just
   doesn't work", with nothing on screen to explain it. Null keys are omitted on
   write and read through `isNull()` now, pinned by a test.

A fourth red was not a defect: a full Actions artifact quota failed the upload
step of an otherwise-green build. That step is `continue-on-error` now, because
reporting a compile failure that did not happen is the worst kind of red — and
distribution goes through the release upload on a tag, which does not consume
artifact storage.

## Android specifics that bite

- **Foreground service is mandatory.** A background app is frozen by Doze and
  the poll simply stops; the notification is the price of a printer that works
  at 23:00. Type `connectedDevice|dataSync` (Android 14 requires a type).
- **Runtime permissions:** `BLUETOOTH_CONNECT` (+`BLUETOOTH_SCAN`) on API 31+;
  `ACCESS_FINE_LOCATION` below 31, because AOSP treats any BT enumeration as
  location. `POST_NOTIFICATIONS` on 33+ or the foreground notification is silent.
- **Battery optimisation exemption** must be requested explicitly. Without it
  OEM skins (Xiaomi, Oppo, Samsung) kill the service overnight.
- **Cleartext to printers:** `network_security_config` permits cleartext to
  local IPs; the cloud stays HTTPS.
- **Bridge binds loopback only.** Chrome treats `http://127.0.0.1` as a secure
  origin, so `https://dine.kliovo.com` → `http://127.0.0.1:6310` is allowed —
  this is exactly what the desktop agent already relies on in production. Keep
  `Access-Control-Allow-Private-Network: true` on the preflight.
- **No local build here:** this machine has no Android SDK. The project compiles
  in CI (`android.yml`), so treat CI as the gate, not a local `gradle` run.
- **Signing:** release builds sign from repo secrets when present, otherwise CI
  publishes a debug-signed APK. A debug-signed build installs fine for
  sideloading but changes signature between key rotations — set the secrets
  before shipping to branches, or every update becomes an uninstall/reinstall.
