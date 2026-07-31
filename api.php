<?php
/**
 * GHSM REST API
 * Real ESP32 firmware and the browser's Demo Mode simulator both call
 * this exact same API — that's what lets simulated data be swapped for
 * real hardware later without touching the frontend at all.
 */

require_once __DIR__ . '/db.php';

header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') { exit; }

$pdo    = ghsm_db();
$route  = $_GET['route'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];
$body   = json_decode(file_get_contents('php://input'), true) ?? [];

function respond($data, int $code = 200): void {
    http_response_code($code);
    echo json_encode($data);
    exit;
}

function now(): string { return date('c'); }

function create_alert(PDO $pdo, string $type, string $message, string $severity): void {
    $pdo->prepare("INSERT INTO alerts (type, message, severity, read_status, timestamp) VALUES (?,?,?,0,?)")
        ->execute([$type, $message, $severity, now()]);
}

try {
    switch ($route) {

        // ---------------------------------------------------------- dashboard
        case 'dashboard': {
            $latestSensor = $pdo->query("SELECT * FROM sensor_data ORDER BY id DESC LIMIT 1")->fetch(PDO::FETCH_ASSOC);
            $device       = $pdo->query("SELECT * FROM device_status WHERE id=1")->fetch(PDO::FETCH_ASSOC);
            $today        = date('Y-m-d');
            $attempts     = $pdo->prepare("SELECT COUNT(*) FROM access_logs WHERE action='RFID_SCAN' AND timestamp LIKE ?");
            $attempts->execute([$today . '%']);
            $granted      = $pdo->prepare("SELECT COUNT(*) FROM access_logs WHERE result='GRANTED' AND timestamp LIKE ?");
            $granted->execute([$today . '%']);
            $denied       = $pdo->prepare("SELECT COUNT(*) FROM access_logs WHERE result='DENIED' AND timestamp LIKE ?");
            $denied->execute([$today . '%']);

            respond([
                'sensor' => $latestSensor ?: null,
                'device' => $device,
                'today'  => [
                    'attempts' => (int)$attempts->fetchColumn(),
                    'granted'  => (int)$granted->fetchColumn(),
                    'denied'   => (int)$denied->fetchColumn(),
                ],
            ]);
        }

        // ---------------------------------------------------------- sensors
        case 'sensors': {
            if ($method === 'POST') {
                $stmt = $pdo->prepare("INSERT INTO sensor_data (temperature, humidity, soil_moisture, light_intensity, timestamp) VALUES (?,?,?,?,?)");
                $stmt->execute([
                    $body['temperature'] ?? null,
                    $body['humidity'] ?? null,
                    $body['soil_moisture'] ?? null,
                    $body['light_intensity'] ?? null,
                    now(),
                ]);

                // threshold-based alerts
                $settings = $pdo->query("SELECT * FROM settings WHERE id=1")->fetch(PDO::FETCH_ASSOC);
                if (($body['temperature'] ?? 0) > $settings['temperature_threshold']) {
                    create_alert($pdo, 'HIGH_TEMPERATURE', 'Temperature exceeded threshold: ' . $body['temperature'] . '°C', 'WARNING');
                }
                if (($body['soil_moisture'] ?? 100) < $settings['soil_moisture_threshold']) {
                    create_alert($pdo, 'LOW_SOIL_MOISTURE', 'Soil moisture dropped to ' . $body['soil_moisture'] . '%', 'WARNING');
                }
                respond(['ok' => true]);
            }
            // GET history
            $hours = (float)($_GET['hours'] ?? 24);
            $since = date('c', strtotime("-{$hours} hours"));
            $stmt = $pdo->prepare("SELECT * FROM sensor_data WHERE timestamp >= ? ORDER BY id ASC");
            $stmt->execute([$since]);
            respond($stmt->fetchAll(PDO::FETCH_ASSOC));
        }

        // ---------------------------------------------------------- rfid users
        case 'users': {
            if ($method === 'GET') {
                respond($pdo->query("SELECT * FROM users ORDER BY id DESC")->fetchAll(PDO::FETCH_ASSOC));
            }
            if ($method === 'POST') {
                $stmt = $pdo->prepare("INSERT INTO users (name, rfid_uid, access_status, registration_date, last_access, total_accesses) VALUES (?,?,?,?,?,0)");
                $stmt->execute([$body['name'], $body['rfid_uid'], 'AUTHORIZED', now(), null]);
                respond(['ok' => true, 'id' => $pdo->lastInsertId()]);
            }
            if ($method === 'PUT') {
                $id = $_GET['id'] ?? 0;
                $stmt = $pdo->prepare("UPDATE users SET access_status = ? WHERE id = ?");
                $stmt->execute([$body['access_status'], $id]);
                respond(['ok' => true]);
            }
            if ($method === 'DELETE') {
                $id = $_GET['id'] ?? 0;
                $pdo->prepare("DELETE FROM users WHERE id = ?")->execute([$id]);
                respond(['ok' => true]);
            }
            respond(['error' => 'unsupported method'], 405);
        }

        // ---------------------------------------------------------- rfid scan (this is what the ESP32 calls)
        case 'rfid/scan': {
            $uid = $body['rfid_uid'] ?? '';
            $stmt = $pdo->prepare("SELECT * FROM users WHERE rfid_uid = ?");
            $stmt->execute([$uid]);
            $user = $stmt->fetch(PDO::FETCH_ASSOC);

            $settings = $pdo->query("SELECT * FROM settings WHERE id=1")->fetch(PDO::FETCH_ASSOC);

            if ($user && $user['access_status'] === 'AUTHORIZED') {
                // ACCESS GRANTED
                $pdo->prepare("UPDATE users SET last_access=?, total_accesses = total_accesses + 1 WHERE id=?")
                    ->execute([now(), $user['id']]);
                $pdo->prepare("UPDATE device_status SET door_lock='UNLOCK', updated_at=? WHERE id=1")->execute([now()]);
                $pdo->prepare("INSERT INTO access_logs (user_id,user_name,rfid_uid,action,result,door_status,source,timestamp) VALUES (?,?,?,?,?,?,?,?)")
                    ->execute([$user['id'], $user['name'], $uid, 'DOOR_UNLOCK', 'GRANTED', 'UNLOCKED', 'RFID', now()]);

                respond([
                    'result'      => 'GRANTED',
                    'user'        => $user['name'],
                    'rfid_uid'    => $uid,
                    'door'        => 'UNLOCKED',
                    'auto_lock_in'=> (int)$settings['auto_lock_duration'],
                ]);
            } else {
                // ACCESS DENIED
                $pdo->prepare("INSERT INTO access_logs (user_id,user_name,rfid_uid,action,result,door_status,source,timestamp) VALUES (?,?,?,?,?,?,?,?)")
                    ->execute([null, 'Unknown', $uid, 'RFID_SCAN', 'DENIED', 'LOCKED', 'RFID', now()]);
                $pdo->prepare("UPDATE device_status SET buzzer='ON', updated_at=? WHERE id=1")->execute([now()]);
                create_alert($pdo, 'UNAUTHORIZED_ACCESS', "Unauthorized RFID access attempt detected (UID {$uid}).", 'CRITICAL');

                respond([
                    'result'   => 'DENIED',
                    'user'     => 'Unknown',
                    'rfid_uid' => $uid,
                    'door'     => 'LOCKED',
                ]);
            }
        }

        // ---------------------------------------------------------- access logs
        case 'access-logs': {
            $stmt = $pdo->query("SELECT * FROM access_logs ORDER BY id DESC LIMIT 500");
            respond($stmt->fetchAll(PDO::FETCH_ASSOC));
        }

        case 'access-logs/export': {
            header('Content-Type: text/csv');
            header('Content-Disposition: attachment; filename="access_records.csv"');
            $out = fopen('php://output', 'w');
            fputcsv($out, ['Date','Time','User','RFID UID','Action','Door Status','Result','Source']);
            $rows = $pdo->query("SELECT * FROM access_logs ORDER BY id DESC")->fetchAll(PDO::FETCH_ASSOC);
            foreach ($rows as $r) {
                $ts = strtotime($r['timestamp']);
                fputcsv($out, [date('d/m/Y',$ts), date('h:i A',$ts), $r['user_name'], $r['rfid_uid'], $r['action'], $r['door_status'], $r['result'], $r['source']]);
            }
            fclose($out);
            exit;
        }

        // ---------------------------------------------------------- door
        case 'door': {
            $action = $body['action'] ?? ''; // unlock | lock
            $source = $body['source'] ?? 'MANUAL';
            $state  = $action === 'unlock' ? 'UNLOCK' : 'LOCK';
            $pdo->prepare("UPDATE device_status SET door_lock=?, updated_at=? WHERE id=1")->execute([$state, now()]);

            $logAction = $source === 'SYSTEM' ? 'AUTO_LOCK' : ($action === 'unlock' ? 'MANUAL_UNLOCK' : 'MANUAL_LOCK');
            $pdo->prepare("INSERT INTO access_logs (user_id,user_name,rfid_uid,action,result,door_status,source,timestamp) VALUES (NULL,'System','-',?,?,?,?,?)")
                ->execute([$logAction, 'SUCCESS', $state === 'UNLOCK' ? 'UNLOCKED' : 'LOCKED', $source, now()]);

            respond(['ok' => true, 'door' => $state]);
        }

        // ---------------------------------------------------------- devices
        case 'devices': {
            if ($method === 'GET') {
                respond($pdo->query("SELECT * FROM device_status WHERE id=1")->fetch(PDO::FETCH_ASSOC));
            }
            if ($method === 'POST') {
                $field = $body['device'] ?? '';
                $value = $body['state'] ?? '';
                $allowed = ['fan','water_pump','greenhouse_light','buzzer','door_lock','mode'];
                if (!in_array($field, $allowed, true)) respond(['error' => 'invalid device'], 400);
                $pdo->prepare("UPDATE device_status SET {$field} = ?, updated_at = ? WHERE id=1")->execute([$value, now()]);
                respond(['ok' => true]);
            }
            respond(['error' => 'unsupported method'], 405);
        }

        // ---------------------------------------------------------- alerts
        case 'alerts': {
            if ($method === 'GET') {
                respond($pdo->query("SELECT * FROM alerts ORDER BY id DESC LIMIT 200")->fetchAll(PDO::FETCH_ASSOC));
            }
            if ($method === 'PUT') {
                $id = $_GET['id'] ?? 0;
                if ($id === 'all') {
                    $pdo->exec("UPDATE alerts SET read_status = 1");
                } else {
                    $pdo->prepare("UPDATE alerts SET read_status = 1 WHERE id = ?")->execute([$id]);
                }
                respond(['ok' => true]);
            }
            respond(['error' => 'unsupported method'], 405);
        }

        // ---------------------------------------------------------- settings
        case 'settings': {
            if ($method === 'GET') {
                respond($pdo->query("SELECT * FROM settings WHERE id=1")->fetch(PDO::FETCH_ASSOC));
            }
            if ($method === 'PUT') {
                $stmt = $pdo->prepare("UPDATE settings SET auto_lock_duration=?, temperature_threshold=?, soil_moisture_threshold=?, humidity_threshold=?, buzzer_duration=?, system_mode=? WHERE id=1");
                $stmt->execute([
                    $body['auto_lock_duration'], $body['temperature_threshold'], $body['soil_moisture_threshold'],
                    $body['humidity_threshold'], $body['buzzer_duration'], $body['system_mode'],
                ]);
                respond(['ok' => true]);
            }
            respond(['error' => 'unsupported method'], 405);
        }

        default:
            respond(['error' => 'unknown route'], 404);
    }
} catch (Throwable $e) {
    respond(['error' => 'server error', 'detail' => $e->getMessage()], 500);
}
