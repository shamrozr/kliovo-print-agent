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

CREATE TABLE IF NOT EXISTS menu_categories (
  id            TEXT PRIMARY KEY,
  name          TEXT,
  sort_order    INTEGER DEFAULT 0,
  is_active     INTEGER DEFAULT 1,
  updated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS menu_items (
  id              TEXT PRIMARY KEY,
  category_id     TEXT,
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
`;
