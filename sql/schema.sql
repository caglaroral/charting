-- Charting app schema (multi-tenant). Applied automatically by server.py at startup.
-- Statements are separated by a line containing only a semicolon-terminated statement end.
-- Every user-owned table is keyed by user_id first. Rows are versioned with updated_at
-- (ReplacingMergeTree) and read with FINAL. Soft delete via deleted = 1.

CREATE DATABASE IF NOT EXISTS charting;

-- Identity is pluggable: (auth_provider, external_id) maps an outside identity
-- (local password, proxy header, OIDC/IAM subject) to the internal user id.
-- All user data references users.id only, so switching providers never touches data.
CREATE TABLE IF NOT EXISTS charting.users
(
    id String,
    auth_provider LowCardinality(String) DEFAULT 'local',
    external_id String DEFAULT '',
    username String,
    email String DEFAULT '',
    password_hash String DEFAULT '',
    display_name String DEFAULT '',
    is_admin UInt8 DEFAULT 0,
    deleted UInt8 DEFAULT 0,
    created_at DateTime64(3) DEFAULT now64(3),
    updated_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY id;

CREATE TABLE IF NOT EXISTS charting.sessions
(
    token String,
    user_id String,
    expires_at DateTime,
    deleted UInt8 DEFAULT 0,
    updated_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY token
TTL expires_at + INTERVAL 1 DAY;

CREATE TABLE IF NOT EXISTS charting.watchlists
(
    user_id String,
    id String,
    name String,
    symbols Array(String),
    sort UInt32 DEFAULT 0,
    deleted UInt8 DEFAULT 0,
    updated_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (user_id, id);

CREATE TABLE IF NOT EXISTS charting.drawings
(
    user_id String,
    symbol LowCardinality(String),
    id String,
    tool LowCardinality(String),
    data String,
    deleted UInt8 DEFAULT 0,
    updated_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (user_id, symbol, id);

CREATE TABLE IF NOT EXISTS charting.settings
(
    user_id String,
    key String,
    value String,
    updated_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (user_id, key);

-- Alerts. kind: price | drawing | indicator. spec is JSON describing the target
-- (price value, drawing id, or indicator type/params/plot and comparison target).
CREATE TABLE IF NOT EXISTS charting.alerts
(
    user_id String,
    id String,
    symbol LowCardinality(String),
    tf LowCardinality(String),
    kind LowCardinality(String),
    cond LowCardinality(String),
    spec String,
    frequency LowCardinality(String) DEFAULT 'once',
    message String DEFAULT '',
    active UInt8 DEFAULT 1,
    last_bar UInt32 DEFAULT 0,
    last_fired UInt32 DEFAULT 0,
    fired_count UInt32 DEFAULT 0,
    created_at DateTime64(3) DEFAULT now64(3),
    deleted UInt8 DEFAULT 0,
    updated_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (user_id, id);

-- Fired alert log
CREATE TABLE IF NOT EXISTS charting.alert_events
(
    user_id String,
    alert_id String,
    symbol LowCardinality(String),
    tf LowCardinality(String),
    bar_time DateTime,
    price Float64,
    message String,
    created_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = MergeTree
ORDER BY (user_id, created_at)
TTL toDateTime(created_at) + INTERVAL 180 DAY;

-- User-written custom indicators (ChartScript = JavaScript with a Pine-like API)
CREATE TABLE IF NOT EXISTS charting.scripts
(
    user_id String,
    id String,
    name String,
    code String,
    deleted UInt8 DEFAULT 0,
    updated_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (user_id, id);

-- Market data sources configured from the UI (global, admin managed). password_enc is encrypted
-- with SECRET_KEY from .env. tables = {"1m": "table", ...}, columns = {"symbol": ..., "time": ...}
CREATE TABLE IF NOT EXISTS charting.datasources
(
    id String,
    name String,
    prefix String,
    url String,
    user String,
    password_enc String,
    database String,
    tables String,
    columns String,
    live String DEFAULT '',
    enabled UInt8 DEFAULT 1,
    sort UInt32 DEFAULT 0,
    deleted UInt8 DEFAULT 0,
    updated_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY id;

-- live = realtime provider for the source ('binance-futures' | 'binance-spot' | '')
ALTER TABLE charting.datasources ADD COLUMN IF NOT EXISTS live String DEFAULT '' AFTER columns;

-- Notification channels per alert: JSON array of app | telegram | email | webhook
ALTER TABLE charting.alerts ADD COLUMN IF NOT EXISTS channels String DEFAULT '["app"]' AFTER message;

-- Subscription plans (limits JSON, null = unlimited) and the user's plan
CREATE TABLE IF NOT EXISTS charting.plans
(
    id String,
    name String,
    limits String,
    sort UInt32 DEFAULT 0,
    deleted UInt8 DEFAULT 0,
    updated_at DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY id;

ALTER TABLE charting.users ADD COLUMN IF NOT EXISTS plan String DEFAULT '' AFTER is_admin;
