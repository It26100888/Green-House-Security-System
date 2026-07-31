<?php
/**
 * GHSM database bootstrap.
 * Uses SQLite so the whole backend runs with zero external services —
 * swap the DSN below for a real Postgres/MySQL connection in production.
 */

function ghsm_db(): PDO {
    static $pdo = null;
    if ($pdo !== null) return $pdo;

    $dbFile = __DIR__ . '/../database/ghsm.sqlite';
    $isNew = !file_exists($dbFile);

    $pdo = new PDO('sqlite:' . $dbFile);
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->exec('PRAGMA foreign_keys = ON;');

    if ($isNew) {
        ghsm_migrate($pdo);
        ghsm_seed($pdo);
    }
    return $pdo;
}

function ghsm_migrate(PDO $pdo): void {
    $pdo->exec("
    CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        rfid_uid TEXT UNIQUE NOT NULL,
        access_status TEXT NOT NULL DEFAULT 'AUTHORIZED', -- AUTHORIZED | DISABLED
        registration_date TEXT NOT NULL,
        last_access TEXT,
        total_accesses INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE access_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        user_name TEXT NOT NULL,
        rfid_uid TEXT NOT NULL,
        action TEXT NOT NULL,     -- RFID_SCAN, DOOR_UNLOCK, DOOR_LOCK, AUTO_LOCK, MANUAL_UNLOCK, MANUAL_LOCK
        result TEXT NOT NULL,     -- GRANTED, DENIED, SUCCESS, FAILED
        door_status TEXT NOT NULL, -- LOCKED, UNLOCKED
        source TEXT NOT NULL,      -- RFID, SYSTEM, MANUAL
        timestamp TEXT NOT NULL
    );

    CREATE TABLE sensor_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        temperature REAL,
        humidity REAL,
        soil_moisture REAL,
        light_intensity REAL,
        timestamp TEXT NOT NULL
    );

    CREATE TABLE device_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        fan TEXT NOT NULL DEFAULT 'OFF',
        water_pump TEXT NOT NULL DEFAULT 'OFF',
        greenhouse_light TEXT NOT NULL DEFAULT 'OFF',
        buzzer TEXT NOT NULL DEFAULT 'OFF',
        door_lock TEXT NOT NULL DEFAULT 'LOCK',
        mode TEXT NOT NULL DEFAULT 'AUTO',
        updated_at TEXT
    );

    CREATE TABLE alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        severity TEXT NOT NULL, -- CRITICAL, WARNING, INFORMATION, NORMAL
        read_status INTEGER NOT NULL DEFAULT 0,
        timestamp TEXT NOT NULL
    );

    CREATE TABLE settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        auto_lock_duration INTEGER NOT NULL DEFAULT 5,
        temperature_threshold REAL NOT NULL DEFAULT 30,
        soil_moisture_threshold REAL NOT NULL DEFAULT 30,
        humidity_threshold REAL NOT NULL DEFAULT 80,
        buzzer_duration INTEGER NOT NULL DEFAULT 3,
        system_mode TEXT NOT NULL DEFAULT 'ARMED'
    );
    ");
}

function ghsm_seed(PDO $pdo): void {
    $now = date('c');
    $pdo->prepare("INSERT INTO users (name, rfid_uid, access_status, registration_date, last_access, total_accesses)
                    VALUES (?,?,?,?,?,?)")
        ->execute(['Theekshana', 'A4:B2:91:7C', 'AUTHORIZED', $now, null, 0]);
    $pdo->prepare("INSERT INTO users (name, rfid_uid, access_status, registration_date, last_access, total_accesses)
                    VALUES (?,?,?,?,?,?)")
        ->execute(['User 02', '72:44:18:AC', 'AUTHORIZED', $now, null, 0]);

    $pdo->exec("INSERT INTO device_status (id, fan, water_pump, greenhouse_light, buzzer, door_lock, mode, updated_at)
                VALUES (1,'OFF','OFF','OFF','OFF','LOCK','AUTO','" . $now . "')");

    $pdo->exec("INSERT INTO settings (id) VALUES (1)");
}
