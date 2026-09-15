'use strict';
require('./sinotrack-gateway-v2.js');
setTimeout(() => {
  console.log('SINOTRACK_TCP_PROXY=' + (process.env.RAILWAY_TCP_PROXY_DOMAIN || 'missing') + ':' + (process.env.RAILWAY_TCP_PROXY_PORT || 'missing'));
}, 2000);
