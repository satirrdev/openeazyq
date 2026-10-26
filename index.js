require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const botModule = require('./bot');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN tidak ada di .env, gan!');
  process.exit(1);
}

// Long polling for local dev (MVP phase); autoRestart heals flaky networks
const bot = new TelegramBot(token, { polling: { autoRestart: true, interval: 1500 } });

botModule.register(bot);

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

console.log('🤖 GampangBot jalan nih! Legs polling aktif. Gaskeun!');
