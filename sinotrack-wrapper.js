'use strict';
require('./sinotrack-gateway-v2.js');

async function authProbe(label, url, method, headerName, secret, body) {
  try {
    const options = { method, headers: { [headerName]: secret || '' } };
    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    const text = await response.text();
    console.log(label + '=' + response.status + ':' + text.slice(0, 180));
  } catch (error) {
    console.log(label + '=ERROR:' + error.message);
  }
}

setTimeout(async () => {
  console.log('SINOTRACK_TCP_PROXY=' + (process.env.RAILWAY_TCP_PROXY_DOMAIN || 'missing') + ':' + (process.env.RAILWAY_TCP_PROXY_PORT || 'missing'));
  const lcmSecret = process.env.LCM_SHARED_SECRET || '';
  const candidate = process.env.KODI_API_SECRET_CANDIDATE || '';
  await authProbe('LCMAPI_LOOKUP_SECRET', 'https://localconcretingmate.com.au/functions/lcmApi', 'POST', 'X-Kodi-Shared-Secret', lcmSecret, { action: 'health' });
  await authProbe('KODIAPI_LOOKUP_SECRET', 'https://localconcretingmate.com.au/functions/kodiApi', 'GET', 'X-Kodi-Api-Key', lcmSecret);
  await authProbe('KODIAPI_V2_SECRET', 'https://localconcretingmate.com.au/functions/kodiApi', 'GET', 'X-Kodi-Api-Key', candidate);
}, 2000);
