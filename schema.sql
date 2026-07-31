-- GHSM schema (reference copy — the live SQLite DB is created automatically
-- by php/db.php on first request). Statements below are portable to
-- Postgres/MySQL if you swap the backend later.

CREATE TABLE users (
    id                 INTEGER PRIMARY KEY,
    name               TEXT NOT NULL,
    rfid_uid           TEXT UNIQUE NOT NULL,
    access_status      TEXT NOT NULL DEFAULT 'AUTHORIZED', -- AUTHORIZED | DISABLED
    registration_date  TEXT NOT NULL,
    last_access        TEXT,
    total_accesses     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE access_logs (
    id           INTEGER PRIMARY KEY,
    user_id      INTEGER,
    user_name    TEXT NOT NULL,
    rfid_uid     TEXT NOT NULL,
    action       TEXT NOT NULL,  -- RFID_SCAN, DOOR_UNLOCK, DOOR_LOCK, AUTO_LOCK, MANUAL_UNLOCK, MANUAL_LOCK
    result       TEXT NOT NULL,  -- GRANTED, DENIED, SUCCESS, FAILED
    door_status  TEXT NOT NULL,  -- LOCKED, UNLOCKED
    source       TEXT NOT NULL,  -- RFID, SYSTEM, MANUAL
    timestamp    TEXT NOT NULL
);

CREATE TABLE sensor_data (
    id                INTEGER PRIMARY KEY,
    temperature       REAL,
    humidity          REAL,
    soil_moisture     REAL,
    light_intensity   REAL,
    timestamp         TEXT NOT NULL
);

CREATE TABLE device_status (
    id                 INTEGER PRIMARY KEY,
    fan                TEXT NOT NULL DEFAULT 'OFF',
    water_pump         TEXT NOT NULL DEFAULT 'OFF',
    greenhouse_light   TEXT NOT NULL DEFAULT 'OFF',
    buzzer             TEXT NOT NULL DEFAULT 'OFF',
    door_lock          TEXT NOT NULL DEFAULT 'LOCK',
    mode               TEXT NOT NULL DEFAULT 'AUTO',
    updated_at         TEXT
);

CREATE TABLE alerts (
    id            INTEGER PRIMARY KEY,
    type          TEXT NOT NULL,
    message       TEXT NOT NULL,
    severity      TEXT NOT NULL, -- CRITICAL, WARNING, INFORMATION, NORMAL
    read_status   INTEGER NOT NULL DEFAULT 0,
    timestamp     TEXT NOT NULL
);

CREATE TABLE settings (
    id                        INTEGER PRIMARY KEY,
    auto_lock_duration        INTEGER NOT NULL DEFAULT 5,
    temperature_threshold     REAL NOT NULL DEFAULT 30,
    soil_moisture_threshold   REAL NOT NULL DEFAULT 30,
    humidity_threshold        REAL NOT NULL DEFAULT 80,
    buzzer_duration           INTEGER NOT NULL DEFAULT 3,
    system_mode               TEXT NOT NULL DEFAULT 'ARMED'
);
