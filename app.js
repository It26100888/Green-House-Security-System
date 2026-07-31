/* =========================================================================
   GHSM front end.
   Talks to php/api.php. If that endpoint can't be reached (e.g. the file
   was opened directly instead of served through PHP), it transparently
   falls back to an in-memory mock of the exact same API so the demo still
   works. Either way the rendering code below never knows the difference —
   that's the point: real ESP32 traffic hits the same routes.
   ========================================================================= */

const API_BASE = 'php/api.php';
let backendAvailable = null; // null = unknown, true/false once probed

// ---------------------------------------------------------------- local fallback store
const Local = {
  users: [
    { id: 1, name: 'Theekshana', rfid_uid: 'A4:B2:91:7C', access_status: 'AUTHORIZED', registration_date: new Date().toISOString(), last_access: null, total_accesses: 0 },
    { id: 2, name: 'User 02', rfid_uid: '72:44:18:AC', access_status: 'AUTHORIZED', registration_date: new Date().toISOString(), last_access: null, total_accesses: 0 },
  ],
  accessLogs: [],
  sensorData: [],
  device: { fan: 'OFF', water_pump: 'OFF', greenhouse_light: 'OFF', buzzer: 'OFF', door_lock: 'LOCK', mode: 'AUTO', updated_at: new Date().toISOString() },
  alerts: [],
  settings: { auto_lock_duration: 5, temperature_threshold: 30, soil_moisture_threshold: 30, humidity_threshold: 80, buzzer_duration: 3, system_mode: 'ARMED' },
  nextUserId: 3,
  nextLogId: 1,
  nextAlertId: 1,
};

function localAlert(type, message, severity) {
  Local.alerts.unshift({ id: Local.nextAlertId++, type, message, severity, read_status: 0, timestamp: new Date().toISOString() });
}
function localLog({ user_id = null, user_name, rfid_uid, action, result, door_status, source }) {
  Local.accessLogs.unshift({ id: Local.nextLogId++, user_id, user_name, rfid_uid, action, result, door_status, source, timestamp: new Date().toISOString() });
}

async function realFetch(route, { method = 'GET', body = null, qs = {} } = {}) {
  const params = new URLSearchParams({ route, ...qs });
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}?${params.toString()}`, opts);
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || 'request failed'); }
  return res.json();
}

async function api(route, opts = {}) {
  if (backendAvailable !== false) {
    try {
      const data = await realFetch(route, opts);
      if (backendAvailable === null) { backendAvailable = true; }
      return data;
    } catch (err) {
      if (backendAvailable === null) {
        backendAvailable = false;
        toast('Running in local demo mode (PHP backend not reachable).', 'warn');
      } else if (backendAvailable === true) {
        throw err; // real backend was working, this is a genuine error
      }
    }
  }
  return localApi(route, opts);
}

function localApi(route, { method = 'GET', body = null, qs = {} } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  switch (route) {
    case 'dashboard': {
      const latest = Local.sensorData[Local.sensorData.length - 1] || null;
      const todays = Local.accessLogs.filter(l => l.timestamp.slice(0, 10) === today);
      return {
        sensor: latest, device: Local.device,
        today: {
          attempts: todays.filter(l => l.action === 'RFID_SCAN' || l.result === 'GRANTED' || l.result === 'DENIED').length,
          granted: todays.filter(l => l.result === 'GRANTED').length,
          denied: todays.filter(l => l.result === 'DENIED').length,
        },
      };
    }
    case 'sensors': {
      if (method === 'POST') {
        Local.sensorData.push({ ...body, timestamp: new Date().toISOString() });
        if (Local.sensorData.length > 3000) Local.sensorData.shift();
        if (body.temperature > Local.settings.temperature_threshold) localAlert('HIGH_TEMPERATURE', `Temperature exceeded threshold: ${body.temperature}°C`, 'WARNING');
        if (body.soil_moisture < Local.settings.soil_moisture_threshold) localAlert('LOW_SOIL_MOISTURE', `Soil moisture dropped to ${body.soil_moisture}%`, 'WARNING');
        return { ok: true };
      }
      const hours = Number(qs.hours || 24);
      const since = Date.now() - hours * 3600 * 1000;
      return Local.sensorData.filter(s => new Date(s.timestamp).getTime() >= since);
    }
    case 'users': {
      if (method === 'GET') return [...Local.users].reverse();
      if (method === 'POST') {
        const u = { id: Local.nextUserId++, name: body.name, rfid_uid: body.rfid_uid, access_status: 'AUTHORIZED', registration_date: new Date().toISOString(), last_access: null, total_accesses: 0 };
        Local.users.push(u);
        return { ok: true, id: u.id };
      }
      if (method === 'PUT') {
        const u = Local.users.find(x => x.id === Number(qs.id));
        if (u) u.access_status = body.access_status;
        return { ok: true };
      }
      if (method === 'DELETE') {
        Local.users = Local.users.filter(x => x.id !== Number(qs.id));
        return { ok: true };
      }
      break;
    }
    case 'rfid/scan': {
      const uid = body.rfid_uid;
      const user = Local.users.find(u => u.rfid_uid === uid);
      if (user && user.access_status === 'AUTHORIZED') {
        user.last_access = new Date().toISOString();
        user.total_accesses += 1;
        Local.device.door_lock = 'UNLOCK';
        Local.device.updated_at = new Date().toISOString();
        localLog({ user_id: user.id, user_name: user.name, rfid_uid: uid, action: 'DOOR_UNLOCK', result: 'GRANTED', door_status: 'UNLOCKED', source: 'RFID' });
        return { result: 'GRANTED', user: user.name, rfid_uid: uid, door: 'UNLOCKED', auto_lock_in: Local.settings.auto_lock_duration };
      }
      localLog({ user_name: 'Unknown', rfid_uid: uid, action: 'RFID_SCAN', result: 'DENIED', door_status: 'LOCKED', source: 'RFID' });
      Local.device.buzzer = 'ON';
      localAlert('UNAUTHORIZED_ACCESS', `Unauthorized RFID access attempt detected (UID ${uid}).`, 'CRITICAL');
      return { result: 'DENIED', user: 'Unknown', rfid_uid: uid, door: 'LOCKED' };
    }
    case 'access-logs':
      return Local.accessLogs.slice(0, 500);
    case 'door': {
      const state = body.action === 'unlock' ? 'UNLOCK' : 'LOCK';
      Local.device.door_lock = state;
      Local.device.updated_at = new Date().toISOString();
      const logAction = body.source === 'SYSTEM' ? 'AUTO_LOCK' : (body.action === 'unlock' ? 'MANUAL_UNLOCK' : 'MANUAL_LOCK');
      localLog({ user_name: 'System', rfid_uid: '-', action: logAction, result: 'SUCCESS', door_status: state === 'UNLOCK' ? 'UNLOCKED' : 'LOCKED', source: body.source || 'MANUAL' });
      return { ok: true, door: state };
    }
    case 'devices': {
      if (method === 'GET') return Local.device;
      if (method === 'POST') { Local.device[body.device] = body.state; Local.device.updated_at = new Date().toISOString(); return { ok: true }; }
      break;
    }
    case 'alerts': {
      if (method === 'GET') return Local.alerts.slice(0, 200);
      if (method === 'PUT') {
        if (qs.id === 'all') Local.alerts.forEach(a => a.read_status = 1);
        else { const a = Local.alerts.find(x => x.id === Number(qs.id)); if (a) a.read_status = 1; }
        return { ok: true };
      }
      break;
    }
    case 'settings': {
      if (method === 'GET') return Local.settings;
      if (method === 'PUT') { Object.assign(Local.settings, body); return { ok: true }; }
      break;
    }
  }
  return {};
}

// ---------------------------------------------------------------- helpers
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast${type === 'error' ? ' error' : type === 'warn' ? ' warn' : ''}`;
  el.textContent = msg;
  document.getElementById('toastStack').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}
function fmtTime(iso) { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
function fmtDate(iso) { return new Date(iso).toLocaleDateString('en-GB'); }
function timeAgo(iso) { if (!iso) return '—'; return new Date(iso).toLocaleString([], { hour: '2-digit', minute: '2-digit' }) + ' · ' + new Date(iso).toLocaleDateString('en-GB'); }

let confirmResolve = null;
function askConfirm(title, body) {
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmBody').textContent = body;
  document.getElementById('confirmBackdrop').classList.add('show');
  return new Promise(resolve => { confirmResolve = resolve; });
}
document.getElementById('confirmOkBtn').onclick = () => { document.getElementById('confirmBackdrop').classList.remove('show'); confirmResolve?.(true); };
document.getElementById('confirmCancelBtn').onclick = () => { document.getElementById('confirmBackdrop').classList.remove('show'); confirmResolve?.(false); };

// ---------------------------------------------------------------- routing / sidebar
const pages = ['dashboard', 'security', 'rfid-users', 'records', 'environment', 'controls', 'alerts', 'settings'];
function goTo(page) {
  pages.forEach(p => {
    document.getElementById(`page-${p}`).classList.toggle('active', p === page);
  });
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  closeSidebar();
  renderPage(page);
}
document.querySelectorAll('.nav-item').forEach(btn => btn.addEventListener('click', () => goTo(btn.dataset.page)));

function openSidebar() { document.getElementById('sidebar').classList.add('open'); document.getElementById('scrim').classList.add('show'); }
function closeSidebar() { document.getElementById('sidebar').classList.remove('open'); document.getElementById('scrim').classList.remove('show'); }
document.getElementById('hamburger').onclick = openSidebar;
document.getElementById('scrim').onclick = closeSidebar;

// ---------------------------------------------------------------- clock + greeting
function tickClock() {
  const now = new Date();
  document.getElementById('clockTime').textContent = now.toLocaleTimeString();
  document.getElementById('clockDate').textContent = now.toLocaleDateString('en-GB');
  const h = now.getHours();
  document.getElementById('greeting').textContent = (h < 12 ? 'Good Morning 👋' : h < 18 ? 'Good Afternoon 👋' : 'Good Evening 👋');
}
setInterval(tickClock, 1000); tickClock();

// ---------------------------------------------------------------- ESP32 / header status
function setEsp32(online) {
  document.getElementById('esp32Dot').className = 'dot ' + (online ? 'dot-green' : 'dot-red');
  document.getElementById('esp32Text').textContent = online ? 'Online' : 'Disconnected';
}
async function refreshDoorChip() {
  const device = await api('devices');
  const locked = device.door_lock !== 'UNLOCK';
  document.getElementById('doorChipText').textContent = locked ? 'LOCKED' : 'UNLOCKED';
  document.getElementById('doorChip').firstChild.textContent = locked ? '🔒 ' : '🔓 ';
  return device;
}

// ---------------------------------------------------------------- DASHBOARD
let dashEnvChart = null;
async function renderDashboard() {
  const [dash, history, alerts] = await Promise.all([api('dashboard'), api('sensors', { qs: { hours: 6 } }), api('alerts')]);
  const s = dash.sensor || { temperature: 0, humidity: 0, soil_moisture: 0, light_intensity: 0 };
  const d = dash.device || {};

  const cards = [
    { icon: '🌡️', label: 'Temperature', value: `${(s.temperature ?? 0).toFixed(1)} °C`, status: 'Normal', cls: 'status-normal' },
    { icon: '💧', label: 'Humidity', value: `${Math.round(s.humidity ?? 0)} %`, status: 'Normal', cls: 'status-normal' },
    { icon: '🌱', label: 'Soil Moisture', value: `${Math.round(s.soil_moisture ?? 0)} %`, status: 'Normal', cls: 'status-normal' },
    { icon: '💡', label: 'Light Intensity', value: `${Math.round(s.light_intensity ?? 0)} Lux`, status: 'Good', cls: 'status-normal' },
    { icon: '🚪', label: 'Door', value: d.door_lock === 'UNLOCK' ? 'UNLOCKED' : 'LOCKED', status: d.door_lock === 'UNLOCK' ? 'Open' : 'Secure', cls: d.door_lock === 'UNLOCK' ? 'status-warn' : 'status-normal' },
    { icon: '🪪', label: 'RFID Reader', value: 'READY', status: 'Waiting for card', cls: 'status-info' },
    { icon: '📡', label: 'ESP32', value: 'ONLINE', status: 'Connected', cls: 'status-normal' },
    { icon: '🛡️', label: 'Security', value: 'SECURE', status: 'System Armed', cls: 'status-normal' },
  ];
  document.getElementById('statusCards').innerHTML = cards.map(c => `
    <div class="card stat-card">
      <div class="stat-top"><span>${c.icon} ${c.label}</span></div>
      <div class="stat-value">${c.value}</div>
      <div class="stat-status ${c.cls}">${c.status}</div>
    </div>`).join('');

  const unread = alerts.filter(a => !a.read_status).length;
  document.getElementById('alertBadge').textContent = unread;
  document.getElementById('notifBadge').textContent = unread;

  const labels = history.map(h => fmtTime(h.timestamp));
  const ctx = document.getElementById('dashEnvChart');
  const datasets = [
    { label: 'Temp °C', data: history.map(h => h.temperature), borderColor: '#f5a524', tension: 0.35 },
    { label: 'Humidity %', data: history.map(h => h.humidity), borderColor: '#4d9fff', tension: 0.35 },
  ];
  if (dashEnvChart) { dashEnvChart.data.labels = labels; dashEnvChart.data.datasets = datasets; dashEnvChart.update(); }
  else dashEnvChart = makeLineChart(ctx, labels, datasets);

  const recent = (await api('access-logs')).slice(0, 8);
  document.getElementById('dashTimeline').innerHTML = recent.map(r => `
    <div class="timeline-item">
      <div class="timeline-time">${fmtTime(r.timestamp)}</div>
      <div class="timeline-text">
        <b>${r.result === 'GRANTED' ? '🟢 Access Granted' : r.result === 'DENIED' ? '🔴 Access Denied' : (r.action === 'AUTO_LOCK' ? '🔒 Auto Lock' : r.action)}</b>
        <span>${r.user_name} · ${r.rfid_uid}</span>
      </div>
    </div>`).join('') || '<div class="sub">No activity yet.</div>';
}

function makeLineChart(ctx, labels, datasets) {
  return new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: datasets.map(d => ({ ...d, fill: false, pointRadius: 0, borderWidth: 2 })) },
    options: {
      responsive: true,
      plugins: { legend: { labels: { color: '#8ba396' } } },
      scales: {
        x: { ticks: { color: '#5c7268', maxTicksLimit: 8 }, grid: { color: 'rgba(255,255,255,0.04)' } },
        y: { ticks: { color: '#5c7268' }, grid: { color: 'rgba(255,255,255,0.04)' } },
      },
    },
  });
}

// ---------------------------------------------------------------- SECURITY / DOOR / SCANNER
async function renderSecurity() {
  const device = await refreshDoorChip();
  const logs = await api('access-logs');
  const today = new Date().toISOString().slice(0, 10);
  const todays = logs.filter(l => l.timestamp.slice(0, 10) === today);
  const lastUnlock = logs.find(l => l.door_status === 'UNLOCKED');
  const lastLock = logs.find(l => l.door_status === 'LOCKED');
  const lastUser = logs.find(l => l.result === 'GRANTED');

  const locked = device.door_lock !== 'UNLOCK';
  const doorVisual = document.getElementById('doorVisual');
  doorVisual.textContent = locked ? '🔒' : '🔓';
  doorVisual.classList.toggle('unlocked', !locked);
  document.getElementById('doorStateText').textContent = locked ? 'DOOR LOCKED' : 'DOOR UNLOCKED';
  const secureBadge = document.getElementById('doorSecureBadge');
  secureBadge.textContent = locked ? 'SECURE' : 'OPEN';
  secureBadge.className = 'badge ' + (locked ? 'badge-green' : 'badge-red');

  document.getElementById('kvLastUser').textContent = lastUser ? lastUser.user_name : '—';
  document.getElementById('kvLastUnlock').textContent = lastUnlock ? timeAgo(lastUnlock.timestamp) : '—';
  document.getElementById('kvLastLock').textContent = lastLock ? timeAgo(lastLock.timestamp) : '—';
  document.getElementById('kvAttempts').textContent = todays.length;
  document.getElementById('kvSuccess').textContent = todays.filter(l => l.result === 'GRANTED' || l.result === 'SUCCESS').length;
  document.getElementById('kvFailed').textContent = todays.filter(l => l.result === 'DENIED').length;
}

document.getElementById('unlockBtn').onclick = async () => {
  if (await askConfirm('Unlock greenhouse door?', 'Are you sure you want to unlock the greenhouse door?')) {
    await api('door', { method: 'POST', body: { action: 'unlock', source: 'MANUAL' } });
    toast('🔓 Door unlocked');
    renderSecurity(); refreshDoorChip();
  }
};
document.getElementById('lockBtn').onclick = async () => {
  await api('door', { method: 'POST', body: { action: 'lock', source: 'MANUAL' } });
  toast('🔒 Door locked');
  renderSecurity(); refreshDoorChip();
};

document.getElementById('simScanBtn').onclick = () => simulateRfidScan();

async function simulateRfidScan(forceUnauthorized = false) {
  const ring = document.getElementById('scannerRing');
  const state = document.getElementById('scannerState');
  const result = document.getElementById('scannerResult');
  ring.className = 'scanner-ring scanning'; ring.textContent = '🔄';
  state.textContent = 'SCANNING RFID CARD...';
  result.textContent = '';

  const users = await api('users');
  let uid;
  if (!forceUnauthorized && users.length && Math.random() > 0.25) {
    uid = users[Math.floor(Math.random() * users.length)].rfid_uid;
  } else {
    uid = randomUID();
  }

  setTimeout(async () => {
    const r = await api('rfid/scan', { method: 'POST', body: { rfid_uid: uid } });
    if (r.result === 'GRANTED') {
      ring.className = 'scanner-ring granted'; ring.textContent = '🟢';
      state.textContent = 'ACCESS GRANTED';
      result.textContent = `User: ${r.user} · UID: ${r.rfid_uid}`;
      toast(`🟢 Access granted — ${r.user}`);
      renderSecurity(); refreshDoorChip();
      setTimeout(async () => {
        result.textContent += ` · Auto lock in ${r.auto_lock_in}s`;
      }, 300);
      setTimeout(async () => {
        await api('door', { method: 'POST', body: { action: 'lock', source: 'SYSTEM' } });
        toast('🔒 Door automatically locked');
        ring.className = 'scanner-ring'; ring.textContent = '🪪';
        state.textContent = 'READY TO SCAN'; result.textContent = '';
        renderSecurity(); refreshDoorChip();
      }, (r.auto_lock_in || 5) * 1000);
    } else {
      ring.className = 'scanner-ring denied'; ring.textContent = '🔴';
      state.textContent = 'ACCESS DENIED';
      result.textContent = `Unknown RFID Card · UID: ${r.rfid_uid}`;
      toast('🔴 Unauthorized RFID access attempt detected.', 'error');
      renderSecurity();
      setTimeout(() => { ring.className = 'scanner-ring'; ring.textContent = '🪪'; state.textContent = 'READY TO SCAN'; result.textContent = ''; }, 2500);
    }
  }, 900);
}
function randomUID() { const h = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase(); return `${h()}:${h()}:${h()}:${h()}`; }

// ---------------------------------------------------------------- RFID USERS
async function renderUsers() {
  const users = await api('users');
  document.querySelector('#usersTable tbody').innerHTML = users.map(u => `
    <tr>
      <td>${u.name}</td>
      <td>${u.rfid_uid}</td>
      <td><span class="pill-status ${u.access_status === 'AUTHORIZED' ? 'pill-authorized' : 'pill-disabled'}">${u.access_status === 'AUTHORIZED' ? '🟢 Authorized' : '🔴 Disabled'}</span></td>
      <td>${fmtDate(u.registration_date)}</td>
      <td>${u.last_access ? timeAgo(u.last_access) : '—'}</td>
      <td>${u.total_accesses}</td>
      <td>
        <button class="action-link" onclick="toggleUser(${u.id}, '${u.access_status}')">${u.access_status === 'AUTHORIZED' ? 'Disable' : 'Enable'}</button>
        <button class="action-link danger" onclick="deleteUser(${u.id})">Delete</button>
      </td>
    </tr>`).join('') || '<tr><td colspan="7">No RFID users registered.</td></tr>';
}
window.toggleUser = async (id, current) => {
  await api('users', { method: 'PUT', qs: { id }, body: { access_status: current === 'AUTHORIZED' ? 'DISABLED' : 'AUTHORIZED' } });
  toast('User access updated'); renderUsers();
};
window.deleteUser = async (id) => {
  if (await askConfirm('Delete RFID user?', 'This permanently removes their access.')) {
    await api('users', { method: 'DELETE', qs: { id } });
    toast('User deleted'); renderUsers();
  }
};

let pendingUID = null;
document.getElementById('addUserBtn').onclick = () => {
  pendingUID = null;
  document.getElementById('newUserName').value = '';
  document.getElementById('scanBoxState').textContent = 'Waiting for RFID card...';
  document.getElementById('registerUserBtn').disabled = true;
  document.getElementById('userModalBackdrop').classList.add('show');
};
document.getElementById('cancelUserBtn').onclick = () => document.getElementById('userModalBackdrop').classList.remove('show');
document.getElementById('scanCardBtn').onclick = () => {
  document.getElementById('scanBoxState').textContent = 'Scanning...';
  setTimeout(() => {
    pendingUID = randomUID();
    document.getElementById('scanBoxState').textContent = `Card Detected — RFID UID: ${pendingUID}`;
    document.getElementById('registerUserBtn').disabled = false;
  }, 900);
};
document.getElementById('registerUserBtn').onclick = async () => {
  const name = document.getElementById('newUserName').value.trim() || 'New User';
  if (!pendingUID) return;
  await api('users', { method: 'POST', body: { name, rfid_uid: pendingUID } });
  document.getElementById('userModalBackdrop').classList.remove('show');
  toast('RFID card successfully registered.');
  renderUsers();
};

// ---------------------------------------------------------------- ACCESS RECORDS
async function renderRecords() {
  const logs = await api('access-logs');
  const search = document.getElementById('recordSearch').value.toLowerCase();
  const filter = document.getElementById('recordFilter').value;
  const dateFilter = document.getElementById('recordDate').value;
  const sort = document.getElementById('recordSort').value;

  let rows = logs.filter(l => {
    if (search && !(`${l.user_name} ${l.rfid_uid} ${l.action}`.toLowerCase().includes(search))) return false;
    if (filter !== 'all') {
      if (filter === 'LOCK' && !l.door_status.includes('LOCKED')) return false;
      if (filter === 'UNLOCK' && l.door_status !== 'UNLOCKED') return false;
      if ((filter === 'GRANTED' || filter === 'DENIED') && l.result !== filter) return false;
    }
    if (dateFilter !== 'all') {
      const days = dateFilter === 'today' ? 1 : Number(dateFilter);
      const cutoff = Date.now() - days * 86400000;
      if (new Date(l.timestamp).getTime() < cutoff) return false;
    }
    return true;
  });
  rows.sort((a, b) => sort === 'newest' ? new Date(b.timestamp) - new Date(a.timestamp) : new Date(a.timestamp) - new Date(b.timestamp));

  const perPage = 10;
  const page = renderRecords._page || 1;
  const pageCount = Math.max(1, Math.ceil(rows.length / perPage));
  const shown = rows.slice((page - 1) * perPage, page * perPage);

  document.querySelector('#recordsTable tbody').innerHTML = shown.map(r => `
    <tr>
      <td>${fmtDate(r.timestamp)}</td>
      <td>${fmtTime(r.timestamp)}</td>
      <td>${r.user_name}</td>
      <td>${r.rfid_uid}</td>
      <td>${r.action}</td>
      <td>${r.door_status === 'UNLOCKED' ? '🔓 Unlocked' : '🔒 Locked'}</td>
      <td>${r.result === 'GRANTED' ? '🟢 Granted' : r.result === 'DENIED' ? '🔴 Denied' : '✅ ' + r.result}</td>
      <td>${r.source}</td>
    </tr>`).join('') || '<tr><td colspan="8">No records match.</td></tr>';

  let pag = '';
  for (let i = 1; i <= pageCount; i++) pag += `<button class="${i === page ? 'active' : ''}" data-p="${i}">${i}</button>`;
  document.getElementById('recordsPagination').innerHTML = pag;
  document.querySelectorAll('#recordsPagination button').forEach(b => b.onclick = () => { renderRecords._page = Number(b.dataset.p); renderRecords(); });
}
['recordSearch', 'recordFilter', 'recordDate', 'recordSort'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => { renderRecords._page = 1; renderRecords(); });
});
document.getElementById('refreshRecordsBtn').onclick = renderRecords;
document.getElementById('exportCsvBtn').onclick = async () => {
  if (backendAvailable) { window.open(`${API_BASE}?route=access-logs/export`, '_blank'); return; }
  const logs = await api('access-logs');
  const header = 'Date,Time,User,RFID UID,Action,Door Status,Result,Source\n';
  const csv = header + logs.map(r => [fmtDate(r.timestamp), fmtTime(r.timestamp), r.user_name, r.rfid_uid, r.action, r.door_status, r.result, r.source].join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'access_records.csv'; a.click();
};

// ---------------------------------------------------------------- ENVIRONMENT
let envCharts = {};
async function renderEnvironment() {
  const hours = Number(document.getElementById('envRange').value);
  const history = await api('sensors', { qs: { hours } });
  const labels = history.map(h => fmtTime(h.timestamp));
  const specs = [
    ['chartTemp', 'temperature', '#f5a524'],
    ['chartHum', 'humidity', '#4d9fff'],
    ['chartSoil', 'soil_moisture', '#34d399'],
    ['chartLight', 'light_intensity', '#c084fc'],
  ];
  specs.forEach(([id, key, color]) => {
    const data = history.map(h => h[key]);
    if (envCharts[id]) { envCharts[id].data.labels = labels; envCharts[id].data.datasets[0].data = data; envCharts[id].update(); }
    else envCharts[id] = makeLineChart(document.getElementById(id), labels, [{ label: key, data, borderColor: color }]);
  });
}
document.getElementById('envRange').addEventListener('change', renderEnvironment);

// ---------------------------------------------------------------- DEVICE CONTROLS
const deviceMeta = [
  { key: 'fan', icon: '💨', name: 'Exhaust Fan', modes: ['OFF', 'ON', 'AUTO'] },
  { key: 'water_pump', icon: '💧', name: 'Water Pump', modes: ['OFF', 'ON', 'AUTO'] },
  { key: 'greenhouse_light', icon: '💡', name: 'Greenhouse Light', modes: ['OFF', 'ON', 'AUTO'] },
  { key: 'buzzer', icon: '🔊', name: 'Buzzer', modes: ['OFF', 'ON'] },
  { key: 'door_lock', icon: '🚪', name: 'Door Lock', modes: ['LOCK', 'UNLOCK'] },
];
async function renderControls() {
  const device = await api('devices');
  document.getElementById('deviceCards').innerHTML = deviceMeta.map(m => `
    <div class="card device-card">
      <div class="device-top"><span class="device-icon">${m.icon}</span><span class="device-name">${m.name}</span></div>
      <div class="device-modes">
        ${m.modes.map(mode => `<button class="mode-btn ${device[m.key] === mode ? 'on' : ''}" data-key="${m.key}" data-mode="${mode}">${mode}</button>`).join('')}
      </div>
      <div class="device-meta">Updated ${timeAgo(device.updated_at)}</div>
    </div>`).join('');
  document.querySelectorAll('#deviceCards .mode-btn').forEach(b => b.onclick = async () => {
    await api('devices', { method: 'POST', body: { device: b.dataset.key, state: b.dataset.mode } });
    toast(`${b.dataset.key.replace('_', ' ')} set to ${b.dataset.mode}`);
    renderControls(); refreshDoorChip();
  });
}

// ---------------------------------------------------------------- ALERTS
async function renderAlerts() {
  const alerts = await api('alerts');
  const sevClass = s => ({ CRITICAL: 'critical', WARNING: 'warning', INFORMATION: '', NORMAL: 'normal' }[s] || '');
  const sevIcon = s => ({ CRITICAL: '🔴', WARNING: '🟠', INFORMATION: '🔵', NORMAL: '🟢' }[s] || '🔵');
  document.getElementById('alertsList').innerHTML = alerts.map(a => `
    <div class="alert-item ${sevClass(a.severity)} ${a.read_status ? 'read' : ''}">
      <div class="alert-icon">${sevIcon(a.severity)}</div>
      <div class="alert-body">
        <div class="alert-title">${a.type.replaceAll('_', ' ')}</div>
        <div class="alert-msg">${a.message}</div>
        <div class="alert-time">${fmtDate(a.timestamp)} · ${fmtTime(a.timestamp)}</div>
      </div>
      ${a.read_status ? '' : `<button onclick="markAlertRead(${a.id})">Mark as Read</button>`}
    </div>`).join('') || '<div class="sub">No alerts.</div>';
  document.getElementById('alertBadge').textContent = alerts.filter(a => !a.read_status).length;
  document.getElementById('notifBadge').textContent = alerts.filter(a => !a.read_status).length;
}
window.markAlertRead = async (id) => { await api('alerts', { method: 'PUT', qs: { id } }); renderAlerts(); };
document.getElementById('markAllReadBtn').onclick = async () => { await api('alerts', { method: 'PUT', qs: { id: 'all' } }); renderAlerts(); };
document.getElementById('notifBtn').onclick = () => goTo('alerts');

// ---------------------------------------------------------------- SETTINGS
async function renderSettings() {
  const s = await api('settings');
  document.getElementById('setAutoLock').value = s.auto_lock_duration;
  document.getElementById('setTempThresh').value = s.temperature_threshold;
  document.getElementById('setSoilThresh').value = s.soil_moisture_threshold;
  document.getElementById('setHumThresh').value = s.humidity_threshold;
  document.getElementById('setBuzzer').value = s.buzzer_duration;
  document.getElementById('setArmed').checked = s.system_mode === 'ARMED';
  document.getElementById('setLastSeen').textContent = 'just now';
}
document.getElementById('saveSettingsBtn').onclick = async () => {
  await api('settings', {
    method: 'PUT', body: {
      auto_lock_duration: Number(document.getElementById('setAutoLock').value),
      temperature_threshold: Number(document.getElementById('setTempThresh').value),
      soil_moisture_threshold: Number(document.getElementById('setSoilThresh').value),
      humidity_threshold: Number(document.getElementById('setHumThresh').value),
      buzzer_duration: Number(document.getElementById('setBuzzer').value),
      system_mode: document.getElementById('setArmed').checked ? 'ARMED' : 'DISARMED',
    }
  });
  document.getElementById('securityChipText').textContent = document.getElementById('setArmed').checked ? 'ARMED' : 'DISARMED';
  toast('Settings saved');
};

// ---------------------------------------------------------------- page dispatcher
function renderPage(page) {
  ({
    dashboard: renderDashboard, security: renderSecurity, 'rfid-users': renderUsers,
    records: renderRecords, environment: renderEnvironment, controls: renderControls,
    alerts: renderAlerts, settings: renderSettings,
  }[page] || (() => {}))();
}

// ---------------------------------------------------------------- DEMO MODE simulator (acts as the ESP32)
let demoTimer = null;
function startDemo() {
  setEsp32(true);
  if (demoTimer) clearInterval(demoTimer);
  demoTimer = setInterval(async () => {
    const reading = {
      temperature: +(24 + Math.random() * 10).toFixed(1),
      humidity: Math.round(55 + Math.random() * 30),
      soil_moisture: Math.round(25 + Math.random() * 50),
      light_intensity: Math.round(300 + Math.random() * 600),
    };
    await api('sensors', { method: 'POST', body: reading });
    if (document.getElementById('page-dashboard').classList.contains('active')) renderDashboard();
    if (document.getElementById('page-environment').classList.contains('active')) renderEnvironment();
    if (document.getElementById('page-alerts').classList.contains('active')) renderAlerts();

    // occasionally simulate an unattended RFID scan in the background
    if (Math.random() < 0.12 && !document.getElementById('page-security').classList.contains('active')) {
      const users = await api('users');
      const uid = (users.length && Math.random() > 0.3) ? users[Math.floor(Math.random() * users.length)].rfid_uid : randomUID();
      const r = await api('rfid/scan', { method: 'POST', body: { rfid_uid: uid } });
      if (r.result === 'GRANTED') {
        toast(`🟢 Access granted — ${r.user}`);
        setTimeout(() => api('door', { method: 'POST', body: { action: 'lock', source: 'SYSTEM' } }), (r.auto_lock_in || 5) * 1000);
      } else {
        toast('🔴 Unauthorized RFID access attempt detected.', 'error');
      }
    }
  }, 5000);
}
function stopDemo() { setEsp32(false); if (demoTimer) clearInterval(demoTimer); demoTimer = null; }
document.getElementById('demoModeToggle').onchange = (e) => e.target.checked ? startDemo() : stopDemo();

// ---------------------------------------------------------------- boot
(async function boot() {
  // seed a bit of history so charts aren't empty on first load
  for (let i = 12; i >= 0; i--) {
    await api('sensors', {
      method: 'POST', body: {
        temperature: +(24 + Math.random() * 8).toFixed(1),
        humidity: Math.round(55 + Math.random() * 25),
        soil_moisture: Math.round(30 + Math.random() * 40),
        light_intensity: Math.round(400 + Math.random() * 400),
      }
    });
  }
  renderPage('dashboard');
  if (document.getElementById('demoModeToggle').checked) startDemo();
})();
