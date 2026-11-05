require('dotenv').config();
const http = require('http'); // Modul bawaan Node.js, nggak perlu install
const TelegramBot = require('node-telegram-bot-api');
const botModule = require('./bot');
const { startBackupScheduler } = require('./backup');
const { startProviderHealthScheduler, stopProviderHealthScheduler } = require('./providers');
const { startPanelServer, stopPanelServer } = require('./panel');

// 1. DUMMY HTTP SERVER (Wajib buat Render Web Service)
const PORT = process.env.PORT || 3000;
const dummyServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('GampangBot is active and polling.\n');
}).listen(PORT, () => {
  console.log(`Dummy health check server running on port ${PORT}`);
});

// 2. EMBEDDED ADMIN PANEL & AI PROVIDER SCHEDULER
const PANEL_PORT = process.env.PANEL_PORT || 5050;
startPanelServer(PANEL_PORT);
startProviderHealthScheduler();

// 3. INISIALISASI TELEGRAM BOT (Polling)
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN tidak ada di .env, gan!');
  process.exit(1);
}
const bot = new TelegramBot(token, { polling: { autoRestart: true } });

// 4. REGISTER ROUTES & ERROR HANDLER
botModule.register(bot);

// 5. START AUTOMATIC BACKUP SCHEDULER
startBackupScheduler(bot);

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

// 6. GRACEFUL SHUTDOWN HANDLERS
function gracefulShutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  try {
    stopProviderHealthScheduler();
    stopPanelServer();
    if (dummyServer && typeof dummyServer.close === 'function') {
      dummyServer.close();
    }
    if (bot && typeof bot.stopPolling === 'function') {
      bot.stopPolling().then(() => {
        console.log('Bot polling stopped. Exiting process.');
        process.exit(0);
      }).catch(() => {
        process.exit(0);
      });
      return;
    }
  } catch (e) {
    // ignore
  }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

