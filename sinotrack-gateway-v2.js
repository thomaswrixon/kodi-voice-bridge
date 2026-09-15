'use strict';

const net = require('net');
const http = require('http');

const GPS_PORT = Number(process.env.GPS_PORT || 8090);
const HTTP_PORT = Number(process.env.PORT || 3000);
const LCM_API_URL = process.env.LCM_API_URL || 'https://localconcretingmate.com.au/functions/lcmApi';
const LCM_SHARED_SECRET = process.env.LCM_SHARED_SECRET || '';
const MIN_MOVE_METERS = Number(process.env.MIN_MOVE_METERS || 20);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 120000);
const SPEED_STOP_THRESHOLD = Number(process.env.SPEED_STOP_THRESHOLD || 1);

const lastForwarded = new Map();
let lastLcmError = null;
let lastPacketAt = null;
let forwardedPackets = 0;
let ignoredPackets = 0;

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
function parsePacket(rawMessage) {
  const raw = String(rawMessage || '').trim();
  if (!raw.startsWith('*') || !raw.endsWith('#')) return null;
  const p = raw.slice(0, -1).split(',').map(v => v.trim());
  if (p.length < 4) return null;
  const manufacturer = p[0].slice(1).toUpperCase();
  const trackerId = p[1];
  const type = String(p[2] || '').toUpperCase();
  const o = type === 'V1' ? 3 : type === 'V4' ? 5 : -1;
  if (o < 0 || !trackerId) return null;
  return {
    action: 'upsertFleetGpsState',
    tracker_id: trackerId,
    manufacturer,
    fix_valid: String(p[o + 1] || '').toUpperCase() === 'A',
    latitude: nmeaToDecimal(p[o + 2], String(p[o + 3] || '').toUpperCase(), 2),
    longitude: nmeaToDecimal(p[o + 4], String(p[o + 5] || '').toUpperCase(), 3),
    speed_value: safeNumber(p[o + 6]),
    heading_degrees: safeNumber(p[o + 7]),
    vehicle_status_hex: String(p[o + 9] || '').toUpperCase(),
    device_time_utc: deviceTime(p[o], p[o + 8]),
    received_at: new Date().toISOString(),
    raw_message: raw.slice(0, 2000),
    gateway_source: 'sinotrack'
  };
}
function distanceMeters(a,b,c,d) {
  if (![a,b,c,d].every(Number.isFinite)) return Infinity;
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(c-a), dLon = rad(d-b);
  const x = Math.sin(dLat/2)**2 + Math.cos(rad(a))*Math.cos(rad(c))*Math.sin(dLon/2)**2;
  return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
function moving(speed) { return Number.isFinite(speed) && speed > SPEED_STOP_THRESHOLD; }
function shouldForward(prev, cur) {
  if (!prev) return true;
  if (distanceMeters(+prev.latitude,+prev.longitude,+cur.latitude,+cur.longitude) >= MIN_MOVE_METERS) return true;
  if (Boolean(prev.fix_valid) !== Boolean(cur.fix_valid)) return true;
  if (moving(+prev.speed_value) !== moving(+cur.speed_value)) return true;
  const last = Date.parse(prev.received_at || 0);
  return !Number.isFinite(last) || Date.now() - last >= HEARTBEAT_MS;
}
async function forward(packet) {
  const prev = lastForwarded.get(packet.tracker_id);
  if (!shouldForward(prev, packet)) { ignoredPackets++; return; }
  packet.previous_latitude = prev && Number.isFinite(+prev.latitude) ? +prev.latitude : packet.latitude;
  packet.previous_longitude = prev && Number.isFinite(+prev.longitude) ? +prev.longitude : packet.longitude;
  if (!LCM_SHARED_SECRET) throw new Error('LCM_SHARED_SECRET is not configured');
  const response = await fetch(LCM_API_URL, {
    method: 'POST',
    headers: {'Content-Type':'application/json','X-Kodi-Shared-Secret':LCM_SHARED_SECRET},
    body: JSON.stringify(packet)
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`LCM HTTP ${response.status}: ${text.slice(0,300)}`);
  lastForwarded.set(packet.tracker_id, packet);
  forwardedPackets++;
  lastLcmError = null;
  log(`GPS forwarded tracker=${packet.tracker_id} lat=${packet.latitude} lon=${packet.longitude} speed=${packet.speed_value}`);
}
function processMessage(raw) {
  lastPacketAt = new Date().toISOString();
  const packet = parsePacket(raw);
  if (!packet) { ignoredPackets++; log('Ignored packet:', String(raw).slice(0,240)); return; }
  forward(packet).catch(err => { lastLcmError = err.message; log('LCM GPS forward failed:', err.message); });
}

const tcp = net.createServer(socket => {
  const peer = `${socket.remoteAddress || 'unknown'}:${socket.remotePort || ''}`;
  log('SinoTrack connected:', peer);
  socket.setKeepAlive(true, 30000); socket.setNoDelay(true);
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk.toString('utf8');
    if (buffer.length > 65536) buffer = buffer.slice(-65536);
    let end;
    while ((end = buffer.indexOf('#')) !== -1) {
      const segment = buffer.slice(0, end + 1); buffer = buffer.slice(end + 1);
      const start = segment.lastIndexOf('*');
      processMessage(start >= 0 ? segment.slice(start) : segment);
    }
  });
  socket.on('error', err => log('Socket error:', peer, err.message));
  socket.on('close', () => log('SinoTrack disconnected:', peer));
});
tcp.listen(GPS_PORT, '0.0.0.0', () => log(`SinoTrack TCP listener ready on 0.0.0.0:${GPS_PORT}`));

http.createServer((req,res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ok:true,tcpPort:GPS_PORT,lcmSecretConfigured:Boolean(LCM_SHARED_SECRET),trackedDevices:lastForwarded.size,forwardedPackets,ignoredPackets,lastPacketAt,lastLcmError}));
    return;
  }
  res.writeHead(404); res.end('not found');
}).listen(HTTP_PORT, '0.0.0.0', () => log(`Health server ready on 0.0.0.0:${HTTP_PORT}`));
