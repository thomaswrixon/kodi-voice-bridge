'use strict';
require('./sinotrack-gateway-v2.js');
setTimeout(async () => {
  console.log('SINOTRACK_TCP_PROXY=' + (process.env.RAILWAY_TCP_PROXY_DOMAIN || 'missing') + ':' + (process.env.RAILWAY_TCP_PROXY_PORT || 'missing'));
  try {
    const response = await fetch(process.env.LCM_API_URL || 'https://localconcretingmate.com.au/functions/lcmApi', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Kodi-Shared-Secret': process.env.LCM_SHARED_SECRET || ''
      },
      body: JSON.stringify({ action: 'health' })
    });
    console.log('LCM_GPS_AUTH_CHECK=' + response.status + ':' + (await response.text()).slice(0, 300));
  } catch (error) {
    console.log('LCM_GPS_AUTH_CHECK=ERROR:' + error.message);
  }
}, 2000);
