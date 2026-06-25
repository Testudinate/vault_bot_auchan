'use strict';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const axios = require('axios');
const cfg   = require('./config');

const agent = new (require('https').Agent)({
  rejectUnauthorized: false,
  keepAlive: false,
  secureProtocol: 'TLSv1_2_method',
});

const ax = axios.create({
  baseURL:    'https://botapi.messenger.yandex.net/bot/v1',
  headers:    { Authorization: 'OAuth ' + cfg.YANDEX_BOT_TOKEN },
  httpsAgent: agent,
  timeout:    15000,
});

async function main() {
  console.log('\n🔍 Проверяю доступные чаты бота...\n');

  // 1. Получаем последние updates чтобы узнать chat_id чатов
  try {
    const { data } = await ax.get('/messages/getUpdates/', {
      params: { limit: 100, offset: 0 }
    });
    const updates = data.updates || [];

    // Собираем уникальные чаты
    const chats = new Map();
    for (const u of updates) {
      const id   = u.chat && u.chat.id;
      const type = u.chat && u.chat.type;
      const from = u.from && u.from.display_name;
      if (id && !chats.has(id)) {
        chats.set(id, { id, type, lastFrom: from, lastText: (u.text||'').slice(0,50) });
      }
    }

    console.log('📋 Чаты из последних сообщений (' + chats.size + '):');
    for (const [id, chat] of chats) {
      console.log('  Тип: ' + chat.type);
      console.log('  ID:  ' + id);
      console.log('  От:  ' + chat.lastFrom);
      console.log('  Текст: ' + chat.lastText);

      // Пробуем отправить тестовое сообщение
      try {
        await ax.post('/messages/sendText/', {
          chat_id: id,
          text: '🤖 Тест доступа бота (можно игнорировать)',
        });
        console.log('  ✅ Могу писать в этот чат');
      } catch (e) {
        const status = e.response && e.response.status;
        const msg    = e.response && e.response.data && e.response.data.error && e.response.data.error.message;
        console.log('  ❌ Не могу писать: ' + status + ' ' + (msg || e.message));
      }
      console.log('');
    }

  } catch (e) {
    console.error('Ошибка:', e.message);
  }
}

main();
