'use strict';

const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const GPS_PORT = Number(process.env.GPS_PORT || 8090);
const HTTP_PORT = Number(process.env.PORT || 3000);
const SINOTRACK_HOST = process.env.SINOTRACK_HOST || '45.112.204.246';
const SINOTRACK_PORT = Number(process.env.SINOTRACK_PORT || 8090);
const FLEET_API_KEY = process.env.FLEET_API_KEY || '';
const HISTORY_LIMIT = Math.max(20, Math.min(Number(process.env.HISTORY_LIMIT || 300), 2000));
const EVENT_LIMIT = Math.max(100, Math.min(Number(process.env.EVENT_LIMIT || 2000), 10000));
const SPEED_STOP_THRESHOLD = Number(process.env.SPEED_STOP_THRESHOLD || 1);
const MOVE_DISTANCE_METERS = Math.max(5, Number(process.env.MIN_MOVE_METERS || 20));
const MOVE_WINDOW_METERS = Math.max(MOVE_DISTANCE_METERS, Number(process.env.MOVE_WINDOW_METERS || 35));
const MOVE_WINDOW_MS = Math.max(30000, Number(process.env.MOVE_WINDOW_MS || 90000));
const STOP_CONFIRM_MS = Math.max(60000, Number(process.env.STOP_CONFIRM_MS || 120000));

const trackers = new Map();
const events = [];
let nextEventSeq = 1;
let totalTrackerConnections = 0;
let activeTrackerConnections = 0;
let upstreamConnectionErrors = 0;
let packetsParsed = 0;
let packetsIgnored = 0;
let bytesFromTrackers = 0;
let bytesFromSinoTrack = 0;
let lastPacketAt = null;
let lastUpstreamError = null;

function log(...args) { console.log(new Date().toISOString(), ...args); }
function safeNumber(v) {
  const n = Number.parseFloat(String(v ?? '').trim());
  return Number.isFinite(n) ? n : null;
}
function nmeaToDecimal(raw, hemi, degreeDigits) {
  const value = String(raw || '').trim();
  if (!value || value.length <= degreeDigits) return null;
  const deg = Number.parseInt(value.slice(0, degreeDigits), 10);
  const mins = Number.parseFloat(value.slice(degreeDigits));
  if (!Number.isFinite(deg) || !Number.isFinite(mins)) return null;
  let result = deg + mins / 60;
  if (hemi === 'S' || hemi === 'W') result *= -1;
  return Number(result.toFixed(7));
}
function deviceTime(hhmmss, ddmmyy) {
  const t = String(hhmmss || '').padStart(6, '0');
  const d = String(ddmmyy || '').padStart(6, '0');
  if (!/^\d{6}$/.test(t) || !/^\d{6}$/.test(d)) return null;
  const day = +d.slice(0,2), month = +d.slice(2,4), year = 2000 + +d.slice(4,6);
  const hour = +t.slice(0,2), minute = +t.slice(2,4), second = +t.slice(4,6);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function haversineMeters(lat1, lon1, lat2, lon2) {
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return 0;
  const toRad = d => d * Math.PI / 180;
  const R = 6371000;
  const p1 = toRad(lat1), p2 = toRad(lat2);
  const dp = toRad(lat2 - lat1);
  const dl = toRad(lon2 - lon1);
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function deriveMovement(prev, packet) {
  const nowMs = Date.parse(packet.received_at) || Date.now();
  const history = Array.isArray(prev.history) ? prev.history : [];
  const validHistory = history.filter(h => Number.isFinite(h.latitude) && Number.isFinite(h.longitude));

  const last = validHistory.length ? validHistory[validHistory.length - 1] : null;
  let stepDistanceMeters = 0;
  let derivedSpeedKmh = 0;

  if (last && Number.isFinite(packet.latitude) && Number.isFinite(packet.longitude)) {
    stepDistanceMeters = haversineMeters(last.latitude, last.longitude, packet.latitude, packet.longitude);
    const lastMs = Date.parse(last.at || last.device_time_utc || '');
    const dtSeconds = Number.isFinite(lastMs) && lastMs < nowMs ? (nowMs - lastMs) / 1000 : 0;
    if (dtSeconds > 0 && dtSeconds <= 180) {
      derivedSpeedKmh = (stepDistanceMeters / dtSeconds) * 3.6;
    }
  }

  const recent = validHistory.filter(h => {
    const t = Date.parse(h.at || h.device_time_utc || '');
    return Number.isFinite(t) && nowMs - t <= MOVE_WINDOW_MS;
  });
  const oldestRecent = recent[0] || last;
  const windowDistanceMeters = oldestRecent && Number.isFinite(packet.latitude) && Number.isFinite(packet.longitude)
    ? haversineMeters(oldestRecent.latitude, oldestRecent.longitude, packet.latitude, packet.longitude)
    : 0;

  const reportedMoving = Number.isFinite(packet.speed_value) && packet.speed_value > SPEED_STOP_THRESHOLD;
  const coordinateMoving =
    (stepDistanceMeters >= MOVE_DISTANCE_METERS && derivedSpeedKmh >= 2) ||
    windowDistanceMeters >= MOVE_WINDOW_METERS;

  const movingEvidence = reportedMoving || coordinateMoving;
  const lastMovementAtMs = movingEvidence
    ? nowMs
    : (Date.parse(prev.last_movement_at || '') || 0);

  let state = 'stopped';
  if (movingEvidence) {
    state = 'moving';
  } else if (prev.movement_state === 'moving' && lastMovementAtMs && nowMs - lastMovementAtMs < STOP_CONFIRM_MS) {
    state = 'moving';
  }

  return {
    movement_state: state,
    derived_speed_kmh: Number(derivedSpeedKmh.toFixed(1)),
    step_distance_m: Number(stepDistanceMeters.toFixed(1)),
    window_distance_m: Number(windowDistanceMeters.toFixed(1)),
    last_movement_at: lastMovementAtMs ? new Date(lastMovementAtMs).toISOString() : null,
    movement_source: reportedMoving ? 'reported_speed' : coordinateMoving ? 'gps_displacement' : state === 'moving' ? 'stop_grace' : 'stationary',
  };
}
function parsePacket(rawMessage) {
  const raw = String(rawMessage || '').trim();
  if (!raw.startsWith('*') || !raw.endsWith('#')) return null;
  const p = raw.slice(0, -1).split(',').map(v => v.trim());
  if (p.length < 4) return null;
  const manufacturer = p[0].slice(1).toUpperCase();
  const trackerId = String(p[1] || '').trim();
  const type = String(p[2] || '').toUpperCase();
  if (!trackerId) return null;

  const base = {
    tracker_id: trackerId,
    manufacturer,
    packet_type: type,
    received_at: new Date().toISOString(),
    raw_message: raw.slice(0, 2000)
  };

  const o = type === 'V1' ? 3 : type === 'V4' ? 5 : -1;
  if (o < 0) return base;

  const speed = safeNumber(p[o + 6]);
  return {
    ...base,
    fix_valid: String(p[o + 1] || '').toUpperCase() === 'A',
    latitude: nmeaToDecimal(p[o + 2], String(p[o + 3] || '').toUpperCase(), 2),
    longitude: nmeaToDecimal(p[o + 4], String(p[o + 5] || '').toUpperCase(), 3),
    speed_value: speed,
    heading_degrees: safeNumber(p[o + 7]),
    vehicle_status_hex: String(p[o + 9] || '').toUpperCase(),
    device_time_utc: deviceTime(p[o], p[o + 8])
  };
}

function addEvent(type, trackerId, data = {}) {
  const event = {
    seq: nextEventSeq++,
    type,
    tracker_id: trackerId || null,
    at: new Date().toISOString(),
    ...data
  };
  events.push(event);
  if (events.length > EVENT_LIMIT) events.splice(0, events.length - EVENT_LIMIT);
  return event;
}

function updateTracker(packet, peer) {
  const id = packet.tracker_id;
  const prev = trackers.get(id) || { tracker_id: id, history: [] };
  const previousMovement = prev.movement_state || null;
  const previousFix = prev.fix_valid;
  const movement = deriveMovement(prev, packet);

  const next = {
    ...prev,
    ...packet,
    ...movement,
    peer,
    first_seen_at: prev.first_seen_at || packet.received_at,
    last_seen_at: packet.received_at,
    online: true,
    history: prev.history || []
  };

  if (Number.isFinite(packet.latitude) && Number.isFinite(packet.longitude)) {
    next.history.push({
      at: packet.received_at,
      device_time_utc: packet.device_time_utc || null,
      latitude: packet.latitude,
      longitude: packet.longitude,
      speed_value: packet.speed_value,
      heading_degrees: packet.heading_degrees,
      fix_valid: packet.fix_valid,
      movement_state: movement.movement_state,
      derived_speed_kmh: movement.derived_speed_kmh,
      step_distance_m: movement.step_distance_m,
      movement_source: movement.movement_source,
      vehicle_status_hex: packet.vehicle_status_hex || ''
    });
    if (next.history.length > HISTORY_LIMIT) next.history.splice(0, next.history.length - HISTORY_LIMIT);
  }

  trackers.set(id, next);

  if (!prev.last_seen_at) {
    log(`Tracker identified: ${id} type=${packet.packet_type || 'unknown'} lat=${packet.latitude ?? 'n/a'} lon=${packet.longitude ?? 'n/a'} speed=${packet.speed_value ?? 'n/a'}`);
    addEvent('tracker_seen', id, { peer });
  }
  if (previousMovement && movement.movement_state && previousMovement !== movement.movement_state) {
    addEvent(movement.movement_state === 'moving' ? 'movement_started' : 'movement_stopped', id, {
      latitude: packet.latitude,
      longitude: packet.longitude,
      speed_value: packet.speed_value,
      derived_speed_kmh: movement.derived_speed_kmh,
      movement_source: movement.movement_source
    });
  }
  if (previousFix !== undefined && packet.fix_valid !== undefined && previousFix !== packet.fix_valid) {
    addEvent(packet.fix_valid ? 'gps_fix_restored' : 'gps_fix_lost', id, {
      latitude: packet.latitude,
      longitude: packet.longitude
    });
  }
}

function processTrackerData(chunk, peer, state) {
  bytesFromTrackers += chunk.length;
  lastPacketAt = new Date().toISOString();
  state.buffer += chunk.toString('utf8');
  if (state.buffer.length > 131072) state.buffer = state.buffer.slice(-131072);

  let end;
  while ((end = state.buffer.indexOf('#')) !== -1) {
    const segment = state.buffer.slice(0, end + 1);
    state.buffer = state.buffer.slice(end + 1);
    const start = segment.lastIndexOf('*');
    const raw = start >= 0 ? segment.slice(start) : segment;
    const packet = parsePacket(raw);
    if (!packet) {
      packetsIgnored++;
      continue;
    }
    packetsParsed++;
    state.trackerId = packet.tracker_id || state.trackerId;
    updateTracker(packet, peer);
  }
}

const tcp = net.createServer(trackerSocket => {
  const peer = `${trackerSocket.remoteAddress || 'unknown'}:${trackerSocket.remotePort || ''}`;
  const state = { buffer: '', trackerId: null };
  totalTrackerConnections++;
  activeTrackerConnections++;
  log('Tracker connected:', peer);

  trackerSocket.setKeepAlive(true, 30000);
  trackerSocket.setNoDelay(true);

  const upstream = net.createConnection({ host: SINOTRACK_HOST, port: SINOTRACK_PORT });
  upstream.setKeepAlive(true, 30000);
  upstream.setNoDelay(true);

  // Transparent bidirectional proxy. Parsing is a side effect only; the original
  // bytes are forwarded unchanged so SinoTrack continues to operate normally.
  trackerSocket.pipe(upstream);
  upstream.pipe(trackerSocket);

  trackerSocket.on('data', chunk => processTrackerData(chunk, peer, state));
  upstream.on('data', chunk => { bytesFromSinoTrack += chunk.length; });

  upstream.on('connect', () => {
    lastUpstreamError = null;
    log(`SinoTrack upstream connected for ${peer} -> ${SINOTRACK_HOST}:${SINOTRACK_PORT}`);
  });

  upstream.on('error', err => {
    upstreamConnectionErrors++;
    lastUpstreamError = err.message;
    log('SinoTrack upstream error:', peer, err.message);
    addEvent('upstream_error', state.trackerId, { message: err.message });
    trackerSocket.destroy();
  });

  trackerSocket.on('error', err => log('Tracker socket error:', peer, err.message));
  trackerSocket.on('close', () => {
    activeTrackerConnections = Math.max(0, activeTrackerConnections - 1);
    if (state.trackerId && trackers.has(state.trackerId)) {
      const current = trackers.get(state.trackerId);
      current.online = false;
      current.disconnected_at = new Date().toISOString();
      trackers.set(state.trackerId, current);
      addEvent('tracker_disconnected', state.trackerId, { peer });
    }
    if (!upstream.destroyed) upstream.destroy();
    log('Tracker disconnected:', peer, state.trackerId || 'unknown');
  });

  upstream.on('close', () => {
    if (!trackerSocket.destroyed) trackerSocket.destroy();
  });
});

tcp.listen(GPS_PORT, '0.0.0.0', () => {
  log(`SinoTrack proxy ready on 0.0.0.0:${GPS_PORT}, upstream=${SINOTRACK_HOST}:${SINOTRACK_PORT}`);
});

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, X-Fleet-Api-Key, Content-Type'
  });
  res.end(JSON.stringify(body));
}
function authorized(req) {
  if (!FLEET_API_KEY) return false;
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const direct = String(req.headers['x-fleet-api-key'] || '');
  return bearer === FLEET_API_KEY || direct === FLEET_API_KEY;
}
function publicTracker(t, includeHistory = false) {
  const out = { ...t };
  if (!includeHistory) delete out.history;
  delete out.raw_message;
  return out;
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, X-Fleet-Api-Key, Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS'
    });
    res.end();
    return;
  }

  let url;
  try { url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); }
  catch { return json(res, 400, { ok: false, error: 'bad_url' }); }

  if (req.method === 'GET' && (url.pathname === '/openapi.yaml' || url.pathname === '/openapi.yml')) {
    try {
      const spec = fs.readFileSync(path.join(__dirname, 'sinotrack-fleet-api.openapi.yaml'), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'application/yaml; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(spec);
    } catch (error) {
      json(res, 500, { ok: false, error: 'openapi_unavailable' });
    }
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
    return json(res, 200, {
      ok: true,
      service: 'sinotrack-gateway',
      mode: 'bidirectional_proxy',
      trackerListenPort: GPS_PORT,
      upstreamHost: SINOTRACK_HOST,
      upstreamPort: SINOTRACK_PORT,
      apiConfigured: Boolean(FLEET_API_KEY),
      activeTrackerConnections,
      totalTrackerConnections,
      trackedDevices: trackers.size,
      packetsParsed,
      packetsIgnored,
      bytesFromTrackers,
      bytesFromSinoTrack,
      lastPacketAt,
      upstreamConnectionErrors,
      lastUpstreamError
    });
  }

  if (!authorized(req)) return json(res, 401, { ok: false, error: 'unauthorized' });
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method_not_allowed' });

  if (url.pathname === '/api/status') {
    return json(res, 200, {
      ok: true,
      activeTrackerConnections,
      totalTrackerConnections,
      trackedDevices: trackers.size,
      packetsParsed,
      packetsIgnored,
      lastPacketAt,
      upstreamConnectionErrors,
      lastUpstreamError,
      upstream: { host: SINOTRACK_HOST, port: SINOTRACK_PORT }
    });
  }

  if (url.pathname === '/api/trackers') {
    return json(res, 200, {
      ok: true,
      trackers: Array.from(trackers.values()).map(t => publicTracker(t, false))
    });
  }

  if (url.pathname === '/api/events') {
    const after = Number(url.searchParams.get('after') || 0);
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), 500));
    const filtered = events.filter(e => e.seq > after).slice(-limit);
    return json(res, 200, {
      ok: true,
      next_after: filtered.length ? filtered[filtered.length - 1].seq : after,
      events: filtered
    });
  }

  const trackerMatch = url.pathname.match(/^\/api\/trackers\/([^/]+)$/);
  if (trackerMatch) {
    const id = decodeURIComponent(trackerMatch[1]);
    const tracker = trackers.get(id);
    if (!tracker) return json(res, 404, { ok: false, error: 'tracker_not_found', tracker_id: id });
    return json(res, 200, { ok: true, tracker: publicTracker(tracker, false) });
  }

  const historyMatch = url.pathname.match(/^\/api\/trackers\/([^/]+)\/history$/);
  if (historyMatch) {
    const id = decodeURIComponent(historyMatch[1]);
    const tracker = trackers.get(id);
    if (!tracker) return json(res, 404, { ok: false, error: 'tracker_not_found', tracker_id: id });
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 100), HISTORY_LIMIT));
    return json(res, 200, { ok: true, tracker_id: id, history: tracker.history.slice(-limit) });
  }

  return json(res, 404, { ok: false, error: 'not_found' });
});

server.listen(HTTP_PORT, '0.0.0.0', () => log(`Fleet API ready on 0.0.0.0:${HTTP_PORT}`));
