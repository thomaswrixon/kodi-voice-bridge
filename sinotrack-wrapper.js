'use strict';
const net = require('net');
require('./sinotrack-gateway-v2.js');

function testUpstream() {
  const host = process.env.SINOTRACK_HOST || '45.112.204.246';
  const port = Number(process.env.SINOTRACK_PORT || 8090);
  const socket = net.createConnection({ host, port });
  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    console.log('SINOTRACK_UPSTREAM_CHECK=' + result);
    socket.destroy();
  };
  socket.setTimeout(5000);
  socket.on('connect', () => finish('OK:' + host + ':' + port));
  socket.on('timeout', () => finish('TIMEOUT:' + host + ':' + port));
  socket.on('error', (err) => finish('ERROR:' + err.message));
}

async function testFleetApi() {
  try {
    const response = await fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/status', {
      headers: { 'X-Fleet-Api-Key': process.env.FLEET_API_KEY || '' }
    });
    console.log('FLEET_API_SELF_TEST=' + response.status + ':' + (response.ok ? 'OK' : 'FAIL'));
  } catch (error) {
    console.log('FLEET_API_SELF_TEST=ERROR:' + error.message);
  }
}

setTimeout(() => {
  console.log('SINOTRACK_TCP_PROXY=' + (process.env.RAILWAY_TCP_PROXY_DOMAIN || 'missing') + ':' + (process.env.RAILWAY_TCP_PROXY_PORT || 'missing'));
  testUpstream();
  testFleetApi();
}, 2000);
