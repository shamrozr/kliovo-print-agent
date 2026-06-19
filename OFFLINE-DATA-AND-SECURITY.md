# Kliovo Print Agent — Offline Data & Security

This agent does two jobs on a restaurant's computer:

1. **Printing** (always on) — receives ESC/POS jobs from the Kliovo web app over
   `http://127.0.0.1:6310` and sends them to USB / network thermal printers.
2. **Offline store** (only for tenants with the paid Offline POS feature) — keeps an
   **encrypted local database** warm so the **Aster** desktop app can keep taking
   orders during an internet outage.

> **The agent never connects to the cloud.** It listens only on `127.0.0.1`
> (localhost). It holds **no cloud database URL, no API keys, no admin tokens.**
> The Kliovo web app (running as the logged-in user) is the only thing that talks
> to the cloud; it pushes data *down* to this agent and later pulls offline orders
> *up*. So a compromised agent cannot reach or harm production.

---

## What is stored locally

Everything below lives in **one encrypted SQLite file** (`<userData>/offline/dine-offline.db`),
encrypted with **SQLCipher (AES-256)**.

**Reference data** (mirrored from the cloud while online, kept current — not aged out):
- Branch info & settings (tax rates, service charges, ordering, print config)
- Menu (categories, items, modifiers, portion variants)
- Tables / floor
- Customers (basic: name, phone, email)
- Inventory (ingredients, recipes)
- Terminals (terminal code + offline order-number counter)
- **Users / staff** — see *Credentials* below

**Operational data** (only the last **~2 days**, auto-pruned; see *Retention*):
- Orders, order items, order payments
- Shifts, cash-drawer movements, denomination counts

**Sync bookkeeping:**
- `change_log` — the **outbox**: every order/payment/status change made offline,
  waiting to be reconciled to the cloud
- `sync_state` — the pairing secret, the offline feature flag, last-mirror time,
  per-terminal offline number counters, and active login session tokens

---

## What credentials are stored (and what is NOT)

**Stored (so staff can log in and approve actions with no internet):**

| Item | Form | Why |
|---|---|---|
| Staff **passwords** | **bcrypt hash** (never plaintext) | offline login |
| **Manager PINs** | **bcrypt hash** (never plaintext) | refund / void approvals offline |
| Staff role + permissions | route allow-list | enforce the same access offline as online |
| **Pairing secret** | random token in `sync_state` | so only the local web app can write to the agent |
| **Login session tokens** | random token, 12-hour expiry | keep a cashier signed in during a shift |
| **DB encryption key** | **NOT in the database** — stored in the OS keychain (Windows DPAPI / macOS Keychain) via Electron `safeStorage` | so the DB file is useless without the OS user session |

**Never stored / never present on this machine:**
- Plaintext passwords or PINs
- The cloud database connection string
- Internal API keys, HMAC secrets, admin tokens
- Payment-gateway, AI (OpenRouter), WhatsApp, or media (R2) keys

**Blast radius of a stolen computer:** at most that **one branch's last ~2 days**
of orders plus **bcrypt hashes** (slow and expensive to crack). It can never reach
the cloud or other branches.

---

## Encryption & access control

- DB file encrypted at rest with **SQLCipher** (AES-256). The key is generated once,
  stored in the **OS keychain**, and never written to disk in plaintext.
- All endpoints bind to **`127.0.0.1`** only — not reachable from the network.
- Two separate auth layers on the local API:
  - The **web → agent** mirror/reconcile calls require the **pairing secret**.
  - The **Aster app → agent** order calls require a **login session token** (issued
    only after a valid staff email + password).

---

## Data retention (auto-prune)

A prune job runs hourly:
- **Online-origin** rows older than **2 days** are deleted.
- **Offline** rows that have already been **synced** are deleted.
- **Unsynced offline orders are NEVER deleted**, regardless of age — they are
  preserved until they reconcile to the cloud, so no sale is ever lost even in a
  multi-day outage.

This keeps the local footprint tiny and minimises sensitive data at rest.

---

## How staff / user details flow

Staff are created and managed **only in the cloud** (the Kliovo web app) — same as
always: roles, passwords, manager PINs.

1. **Online:** while a staff member is signed into the web app **on the agent's
   computer**, the web mirrors staff credentials (bcrypt password + manager-PIN
   hashes, role, permissions) down to the agent. Who gets warmed depends on who is
   signed in — so no one ever receives another person's hashes:
   - **Any staff member** (including a cashier) warms **their own** login. So each
     person who signs into the web on this PC self-caches and can then use Aster.
   - An **owner/admin** signing in warms the **whole branch at once** — one admin
     sign-in primes every staff login, including their manager PINs.
   - Practically: have an **owner/admin sign in once** to prime everyone, or let
     each staff member sign into the web here once.
2. **Offline:** staff sign into **Aster** with their **normal Kliovo email + password**.
   The agent verifies it against the mirrored bcrypt hash. Their role/permissions
   apply exactly as online; manager PIN gates refunds/voids.
3. **Visibility:** open the **Agent → Offline POS tab** to see exactly who is cached
   ("Cached Logins"), how many orders are stored, sync state, and storage usage.
4. **Revocation caveat:** changing a role or removing a user takes effect on the
   agent at the **next mirror** (next time that user — or an admin — is online).
   The 2-day window and frequent mirroring keep this short, but it is not instant
   while fully offline.

---

## How to use it (per computer)

1. **Super Admin → Tenants → [tenant] → Offline POS tab → enable.**
2. Install this **Agent** (printing + offline store) and the **Aster** app.
3. While online, have an **owner/admin** sign into the web app on this computer and
   leave it open ~1 minute. This pairs the agent and warms menu, tables, today's
   orders, **and every staff login**. (Each cashier can also self-warm by signing in
   here once.) Confirm it worked in the **Agent → Offline POS tab → Cached Logins**.
4. **During an outage:** open **Aster** → staff sign in with their Kliovo email +
   password → take orders, collect payment, change status. Orders get offline
   numbers like `OFF-T1-00001`.
5. **When the internet is back:** open the web app → **Sync offline orders**
   (`/reconcile`) → review and push to the cloud. Synced orders are then pruned from
   the agent.

---

## Troubleshooting

- **"Wrong email or password" in Aster, even with correct credentials** → that login
  was never warmed. Open the **Agent → Offline POS tab → Cached Logins** to check who
  is cached. If empty/missing: make sure (a) Offline POS is enabled for the tenant,
  and (b) that staff member — or an **owner/admin** — has signed into the web app on
  **this** computer while online.
- **"Local service not found"** → the agent isn't running on this computer.
- **Login worked once, new staff can't log in offline** → their account was added
  after the last mirror; have an admin (or that staff member) go online briefly to
  re-warm, then re-check the Offline POS tab.
