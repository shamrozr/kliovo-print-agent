// Offline-subset schema for the encrypted local DB.
//
// Design notes:
//  - Reference tables (branch/users/terminals/menu/tables/customers/inventory/
//    settings) are kept warm by the mirror and simply upserted — they have no
//    age-based prune.
//  - Transactional tables (orders/shifts/change_log) carry `origin`
//    ('online' | 'offline') and `synced_at` (ms epoch, NULL = unsynced) so the
//    prune job can: drop online rows >2 days old, drop offline rows already
//    synced, and NEVER drop unsynced offline rows.
//  - Child rows cascade with their parent so prune only touches the top level.
//  - Amounts are stored as REAL (rupees) to match order-core's math; paisa
//    sibling columns can be added later if needed for the ledger.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS branch (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT,
  root_tenant_id TEXT,
  name          TEXT,
  settings      TEXT DEFAULT '{}',   -- JSON
  entitlements  TEXT DEFAULT '{}',   -- JSON (e.g. { offline: true })
  updated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  email         TEXT,
  role          TEXT,
  permissions   TEXT DEFAULT '{}',   -- JSON: allowedRoutes / roleOverrides / disabledTabs
  password_hash TEXT,
  pin_hash      TEXT,                -- manager PIN (bcrypt)
  is_active     INTEGER DEFAULT 1,
  updated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS terminals (
  id            TEXT PRIMARY KEY,
  code          TEXT,                -- offline series prefix, set at terminal creation (e.g. "T1")
  name          TEXT,
  offline_seq   INTEGER DEFAULT 0,   -- local monotonic counter for OFF-{code}-... numbers
  config        TEXT DEFAULT '{}',
  updated_at    INTEGER
);

-- Brands (org-scoped in the cloud; mirrored read-only for POS brand filtering +
-- per-line brand stamping so offline sales still track by brand).
CREATE TABLE IF NOT EXISTS brands (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  slug          TEXT,
  color         TEXT,
  logo          TEXT,
  sort_order    INTEGER DEFAULT 0,
  is_active     INTEGER DEFAULT 1,
  updated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS menu_categories (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  brand_id      TEXT,
  sort_order    INTEGER DEFAULT 0,
  is_active     INTEGER DEFAULT 1,
  updated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS menu_items (
  id              TEXT PRIMARY KEY,
  category_id     TEXT,
  brand_id        TEXT,
  name            TEXT,
  price           REAL DEFAULT 0,
  image_url       TEXT,
  station_id      TEXT,
  is_available    INTEGER DEFAULT 1,
  is_active       INTEGER DEFAULT 1,
  dietary         TEXT DEFAULT '[]',  -- JSON
  modifier_groups TEXT DEFAULT '[]',  -- JSON (groups + modifiers, as the POS menu API returns)
  variants        TEXT DEFAULT '[]',  -- JSON (portion-size variants)
  sort_order      INTEGER DEFAULT 0,
  updated_at      INTEGER
);

CREATE TABLE IF NOT EXISTS tables (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  capacity      INTEGER,
  location_id   TEXT,
  location_name TEXT,
  status        TEXT DEFAULT 'available',
  updated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS customers (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  phone         TEXT,
  email         TEXT,
  updated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS ingredients (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  unit          TEXT,
  stock_qty     REAL DEFAULT 0,
  threshold     REAL DEFAULT 0,
  cost_per_unit REAL DEFAULT 0,
  updated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS recipes (
  id            TEXT PRIMARY KEY,
  menu_item_id  TEXT,
  ingredient_id TEXT,
  quantity      REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         TEXT                 -- JSON
);

-- Combos / deals. Prices in rupees (REAL) to match the rest of the offline layer.
CREATE TABLE IF NOT EXISTS combos (
  id          TEXT PRIMARY KEY,
  name        TEXT,
  slug        TEXT,
  brand_id    TEXT,
  combo_price REAL DEFAULT 0,
  image_url   TEXT,
  sort_order  INTEGER DEFAULT 0,
  is_active   INTEGER DEFAULT 1,
  updated_at  INTEGER
);

CREATE TABLE IF NOT EXISTS combo_groups (
  id         TEXT PRIMARY KEY,
  combo_id   TEXT,
  label      TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS combo_group_items (
  id             TEXT PRIMARY KEY,
  combo_group_id TEXT,
  menu_item_id   TEXT,
  variant_id     TEXT,
  is_default     INTEGER DEFAULT 0,
  upcharge       REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS orders (
  id                    TEXT PRIMARY KEY,
  reference             TEXT,
  status                TEXT DEFAULT 'pending',
  source                TEXT,
  table_id              TEXT,
  contact_id            TEXT,
  guest_name            TEXT,
  guest_phone           TEXT,
  covers                INTEGER,
  subtotal              REAL DEFAULT 0,
  tax_amount            REAL DEFAULT 0,
  service_charge_amount REAL DEFAULT 0,
  discount_amount       REAL DEFAULT 0,
  total_amount          REAL DEFAULT 0,
  paid_amount           REAL DEFAULT 0,
  balance_due           REAL DEFAULT 0,
  payment_status        TEXT DEFAULT 'unpaid',
  kitchen_status        TEXT,
  shift_id              TEXT,
  terminal_id           TEXT,
  fields                TEXT DEFAULT '{}',  -- JSON (appliedCharges, deliveryAddress, etc.)
  created_at            INTEGER,
  updated_at            INTEGER,
  origin                TEXT DEFAULT 'offline',
  synced_at             INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created    ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_orders_origin_sync ON orders(origin, synced_at);

CREATE TABLE IF NOT EXISTS order_items (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id  TEXT,
  variant_id    TEXT,
  name          TEXT,
  quantity      INTEGER DEFAULT 1,
  unit_price    REAL DEFAULT 0,
  total_price   REAL DEFAULT 0,
  modifiers     TEXT DEFAULT '[]',  -- JSON
  notes         TEXT,
  course        TEXT,
  station_id    TEXT,
  kitchen_status TEXT DEFAULT 'pending',
  fired_at      INTEGER,
  combo_id      TEXT,
  combo_name    TEXT,
  combo_price   REAL,
  combo_picks   TEXT,
  brand_id      TEXT,
  sort_order    INTEGER DEFAULT 0,
  created_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS order_payments (
  id            TEXT PRIMARY KEY,
  order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method        TEXT,
  amount        REAL DEFAULT 0,
  tip           REAL DEFAULT 0,
  note          TEXT,
  is_refunded   INTEGER DEFAULT 0,
  refunded_at   INTEGER,
  refund_reason TEXT,
  paid_at       INTEGER,
  created_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_order_payments_order ON order_payments(order_id);

CREATE TABLE IF NOT EXISTS shifts (
  id                  TEXT PRIMARY KEY,
  terminal_id         TEXT,
  opening_float_paisa INTEGER DEFAULT 0,
  closing_count_paisa INTEGER,
  expected_cash_paisa INTEGER,
  variance_paisa      INTEGER,
  status              TEXT DEFAULT 'open',
  manager_id          TEXT,
  opened_at           INTEGER,
  closed_at           INTEGER,
  created_at          INTEGER,
  origin              TEXT DEFAULT 'offline',
  synced_at           INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shifts_origin_sync ON shifts(origin, synced_at);

CREATE TABLE IF NOT EXISTS drawer_movements (
  id            TEXT PRIMARY KEY,
  shift_id      TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  type          TEXT,
  amount_paisa  INTEGER DEFAULT 0,
  reason        TEXT,
  note          TEXT,
  created_at    INTEGER
);

CREATE TABLE IF NOT EXISTS shift_counts (
  id            TEXT PRIMARY KEY,
  shift_id      TEXT NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  denomination  INTEGER,
  quantity      INTEGER,
  subtotal_paisa INTEGER
);

-- Outbox: every offline mutation, in order, for the web-driven reconciliation.
CREATE TABLE IF NOT EXISTS change_log (
  id            TEXT PRIMARY KEY,
  entity_type   TEXT,                -- order | payment | item | shift | stock ...
  entity_id     TEXT,
  op            TEXT,                -- create_order | record_payment | update_status | ...
  payload       TEXT DEFAULT '{}',   -- JSON
  terminal_id   TEXT,
  created_at    INTEGER,
  synced_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_change_log_sync ON change_log(synced_at, created_at);

-- Cursors / flags: last_mirror_at, mirror cursors per entity, entitlement, etc.
CREATE TABLE IF NOT EXISTS sync_state (
  key           TEXT PRIMARY KEY,
  value         TEXT
);

-- Print dedup ledger. The server delivers at-least-once (it redelivers any job
-- it never heard an ACK for), so this table is what makes redelivery safe: a
-- job listed here has already hit paper and must NEVER print again.
--
-- The acked flag tracks whether the server was told. An un-acked row is retried
-- from here on later ticks, so an ACK lost to a network blip cannot cause a
-- phantom reprint — the job comes back, we recognise it, and we only re-ACK.
CREATE TABLE IF NOT EXISTS printed_jobs (
  print_job_id  TEXT PRIMARY KEY,
  printer_id    TEXT,
  agent_key     TEXT,
  printed_at    INTEGER NOT NULL,
  acked         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_printed_jobs_ack ON printed_jobs(acked, printed_at)
;

CREATE TABLE IF NOT EXISTS printers (
  id                  TEXT PRIMARY KEY,
  name                TEXT,
  connection          TEXT DEFAULT 'network',
  host                TEXT,
  port                INTEGER,
  system_printer_name TEXT,
  paper_width         INTEGER DEFAULT 80,
  printer_mode        TEXT DEFAULT 'receipt',
  label_language      TEXT,
  label_width_mm      REAL,
  label_height_mm     REAL,
  gap_type            TEXT,
  is_default          INTEGER DEFAULT 0,
  is_active           INTEGER DEFAULT 1,
  updated_at          INTEGER
);
CREATE TABLE IF NOT EXISTS print_routing (
  id               TEXT PRIMARY KEY,
  fulfillment_type TEXT,
  station_id       TEXT,
  printer_id       TEXT NOT NULL,
  copies           INTEGER DEFAULT 1,
  role             TEXT DEFAULT 'kot',
  updated_at       INTEGER
);
CREATE TABLE IF NOT EXISTS kitchen_stations (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  label      TEXT,
  sort_order INTEGER DEFAULT 0,
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS print_templates (
  kind          TEXT PRIMARY KEY,
  layout_config TEXT DEFAULT '{}',
  updated_at    INTEGER
);
CREATE TABLE IF NOT EXISTS branding (
  id         TEXT PRIMARY KEY DEFAULT 'default',
  logo_bytes BLOB,
  name       TEXT,
  address    TEXT,
  phone      TEXT,
  tax_lines  TEXT DEFAULT '[]',
  updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS applied_mutations (
  idempotency_key TEXT PRIMARY KEY,
  order_id        TEXT,
  applied_at      INTEGER NOT NULL
);
`;
