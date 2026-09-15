'use strict';

const net = require('net');
const http = require('http');

const GPS_PORT = Number(process.env.GPS_PORT || 8090);
const HTTP_PORT = Number(process.env.PORT || 3000);
const LCM_APP_ID = process.env.LCM_APP_ID || '695080d2d131b2b3610531de';
const LCM_API_KEY = process.env.LCM_API_KEY || '';
const MIN_MOVE_METERS = Number(process.env.MIN_MOVE_METERS || 20);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 120000);
const SPEED_STOP_THRESHOLD = Number(process.env.SPEED_STOP_THRESHOLD || 1);
const ENTITY_URL = `https://base44.app/api/apps/${LCM_APP_ID}/entities/FleetGpsState`;

const stateCache = new Map();
let cacheLoaded = false;
let lastBase44Error = null;
let lastPacketAt = null;
let acceptedPackets = 0;
let ignoredPackets = 0;

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function safeNumber(value) {
  const n = Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(n) ? n : null;
}

function nmeaToDecimal(raw, hemisphere, degreeDigits) {
  const value = String(raw || '').trim();
  if (!value || value.length <= degreeDigits) return null;
  const degrees = Number.parseInt(value.slice(0, degreeDigits), 10);
  const minutes = Number.parseFloat(value.slice(degreeDigits));
  if (!Number.isFinite(degrees) || !Number.isFinite(minutes)) return null;
  let decimal = degrees + minutes / 60;
  if (hemisphere === 'S' || hemisphere === 'W') decimal *= -1;
  return Number(decimal.toFixed(7));
}

function parseDeviceTime(hhmmss, ddmmyy) {
  const t = String(hhmmss || '').padStart(6, '0');
  const d = String(ddmmyy || '').padStart(6, '0');
  if (!/^\d{6}$/.test(t) || !/^\d{6}$/.test(d)) return null;
  const day = Number(d.slice(0, 2));
  const month = Number(d.slice(2, 4));
  const year = 2000 + Number(d.slice(4, 6));
  const hour = Number(t.slice(0, 2));
  const minute = Number(t.slice(2, 4));
  const second = Number(t.slice(4, 6));
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString();
}

function parsePacket(rawMessage) {
  const raw = String(rawMessage || '').trim();
  if (!raw.startsWith('*') || !raw.endsWith('#')) return null;
  const body = raw.slice(0, -1);
  const parts = body.split(',').map((v) => v.trim());
  if (parts.length < 4) return null;

  const manufacturer = parts[0].slice(1).toUpperCase();
  const trackerId = parts[1];
  const messageType = String(parts[2] || '').toUpperCase();
  let offset;
  if (messageType === 'V1') offset = 3;
  else if (messageType === 'V4') offset = 5;
  else return null;

  const hhmmss = parts[offset];
  const fixFlag = String(parts[offset + 1] || '').toUpperCase();
  const latitude = nmeaToDecimal(parts[offset + 2], String(parts[offset + 3] || '').toUpperCase(), 2);
  const longitude = nmeaToDecimal(parts[offset + 4], String(parts[offset + 5] || '').toUpperCase(), 3);
  const speedValue = safeNumber(parts[offset + 6]);
  const heading = safeNumber(parts[offset + 7]);
  const ddmmyy = parts[offset + 8];
  const vehicleStatus = String(parts[offset + 9] || '').toUpperCase();

  if (!trackerId) return null;
  return {
    tracker_id: trackerId,
    manufacturer,
    message_type: messageType,
    fix_valid: fixFlag === 'A',
    latitude,
    longitude,
    speed_value: speedValue,
    heading_degrees: heading,
    vehicle_status_hex: vehicleStatus,
    device_time_utc: parseDeviceTime(hhmmss, ddmmyy),
    received_at: new Date().toISOString(),
    raw_message: raw.slice(0, 2000),
    gateway_source: 'sinotrack',
  };
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Infinity;
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isMoving(speed) {
  return Number.isFinite(speed) && speed > SPEED_STOP_THRESHOLD;
}

function shouldWrite(previous, current) {
  if (!previous) return true;
  const moved = distanceMeters(
    Number(previous.latitude), Number(previous.longitude),
    Number(current.latitude), Number(current.longitude)
  );
  if (moved >= MIN_MOVE_METERS) return true;
  if (Boolean(previous.fix_valid) !== Boolean(current.fix_valid)) return true;
  if (isMoving(Number(previous.speed_value)) !== isMoving(Number(current.speed_value))) return true;
  const previousReceived = Date.parse(previous.received_at || 0);
  if (!Number.isFinite(previousReceived) || Date.now() - previousReceived >= HEARTBEAT_MS) return true;
  return false;
}

async function base44Request(url, options = {}) {
  if (!LCM_API_KEY) throw new Error('LCM_API_KEY is not configured');
  const headers = Object.assign({}, options.headers || {}, { api_key: LCM_API_KEY });
  const response = await fetch(url, Object.assign({}, options, { headers }));
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) {
    const err = new Error(`Base44 HTTP ${response.status}: ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }
  return data;
}

async function loadStateCache() {
  const data = await base44Request(`${ENTITY_URL}?limit=500&skip=0`);
  const rows = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : []);
  stateCache.clear();
  for (const row of rows) {
    if (row && row.tracker_id) stateCache.set(String(row.tracker_id), row);
  }
  cacheLoaded = true;
  log(`Loaded ${stateCache.size} FleetGpsState records from Base44`);
}

async function upsertState(packet) {
  if (!cacheLoaded) {
    try { await loadStateCache(); } catch (err) { log('Initial Base44 cache load failed:', err.message); }
  }

  const previous = stateCache.get(packet.tracker_id) || null;
  if (!shouldWrite(previous, packet)) {
    ignoredPackets += 1;
    return { written: false, reason: 'throttled' };
  }

  const payload = Object.assign({}, packet, {
    previous_latitude: previous && Number.isFinite(Number(previous.latitude)) ? Number(previous.latitude) : packet.latitude,
    previous_longitude: previous && Number.isFinite(Number(previous.longitude)) ? Number(previous.longitude) : packet.longitude,
  });
  delete payload.message_type;

  let saved;
  if (previous && previous.id) {
    saved = await base44Request(`${ENTITY_URL}/${previous.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } else {
    saved = await base44Request(ENTITY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }

  const next = Object.assign({}, previous || {}, payload, saved || {});
  stateCache.set(packet.tracker_id, next);
  acceptedPackets += 1;
  lastBase44Error = null;
  log(`GPS saved tracker=${packet.tracker_id} lat=${packet.latitude} lon=${packet.longitude} speed=${packet.speed_value}`);
  return { written: true };
}

function processMessage(raw) {
  lastPacketAt = new Date().toISOString();
  const packet = parsePacket(raw);
  if (!packet) {
    ignoredPackets += 1;
    log('Ignored unsupported packet:', String(raw).slice(0, 240));
    return;
  }
  upsertState(packet).catch((err) => {
    lastBase44Error = err.message;
    log('Base44 GPS write failed:', err.message);
  });
}

const tcpServer = net.createServer((socket) => {
  const peer = `${socket.remoteAddress || 'unknown'}:${socket.remotePort || ''}`;
  log('SinoTrack connected:', peer);
  socket.setKeepAlive(true, 30000);
  socket.setNoDelay(true);
  let buffer = '';

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 65536) buffer = buffer.slice(-65536);
    let end;
    while ((end = buffer.indexOf('#')) !== -1) {
      const raw = buffer.slice(0, end + 1);
      buffer = buffer.slice(end + 1);
      const start = raw.lastIndexOf('*');
      processMessage(start >= 0 ? raw.slice(start) : raw);
    }
  });

  socket.on('error', (err) => log('SinoTrack socket error:', peer, err.message));
  socket.on('close', () => log('SinoTrack disconnected:', peer));
});

tcpServer.on('error', (err) => {
  log('TCP server fatal error:', err.message);
  process.exitCode = 1;
});

tcpServer.listen(GPS_PORT, '0.0.0.0', () => {
  log(`SinoTrack TCP listener ready on 0.0.0.0:${GPS_PORT}`);
});

const healthServer = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      tcpPort: GPS_PORT,
      base44Configured: Boolean(LCM_API_KEY),
      cacheLoaded,
      trackedDevices: stateCache.size,
      acceptedPackets,
      ignoredPackets,
      lastPacketAt,
      lastBase44Error,
    }));
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

healthServer.listen(HTTP_PORT, '0.0.0.0', () => {
  log(`Health server ready on 0.0.0.0:${HTTP_PORT}`);
  loadStateCache().catch((err) => {
    lastBase44Error = err.message;
    log('Base44 cache warmup failed:', err.message);
  });
});
