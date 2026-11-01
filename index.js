require('dotenv').config();
const http = require('http'); // Modul bawaan Node.js, nggak perlu install
const TelegramBot = require('node-telegram-bot-api');
const botModule = require('./bot');

// 1. DUMMY HTTP SERVER (Wajib buat Render Web Service)
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('GampangBot is active and polling.\n');
}).listen(PORT, () => {
  console.log(`Dummy health check server running on port ${PORT}`);
});

// 2. INISIALISASI TELEGRAM BOT (Polling)
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN tidak ada di .env, gan!');
  process.exit(1);
}
const bot = new TelegramBot(token, { polling: { autoRestart: true } });

// 3. REGISTER ROUTES & ERROR HANDLER
botModule.register(bot);

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

bot.on('error', (err) => {
  console.error('Bot error event:', err.message);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
});
