'use strict';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const axios = require('axios');
const agent = new (require('https').Agent)({
  rejectUnauthorized: false, keepAlive: false, secureProtocol: 'TLSv1_2_method',
});
require('dotenv').config();
const TOKEN = process.env.YANDEX_BOT_TOKEN;
console.log('Токен:', TOKEN ? TOKEN.slice(0,15)+'...' : 'НЕ НАЙДЕН');
console.log('Запускаю polling, пишите боту...\n');

let offset = 0;
async function poll() {
  while (true) {
    try {
      const { data } = await axios.get(
        'https://botapi.messenger.yandex.net/bot/v1/messages/getUpdates/',
        { headers: { Authorization: 'OAuth ' + TOKEN },
          params: { limit: 10, offset },
          httpsAgent: agent, timeout: 10000 }
      );
      const updates = data.updates || [];
      if (updates.length > 0) {
        console.log('\n=== ПОЛУЧЕНО ' + updates.length + ' сообщений ===');
        for (const u of updates) {
          console.log(JSON.stringify(u, null, 2));
          offset = Math.max(offset, u.update_id + 1);
        }
      } else {
        process.stdout.write('.');
      }
    } catch(e) {
      console.error('\nОшибка:', e.response?.status, e.response?.data || e.message);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}
poll();
