const fs = require('fs');
const path = require('path');

const DAILY_QUIZ_LIMIT = 5;
const MS_PER_DAY = 86400000;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TMP_FILE = path.join(DATA_DIR, 'users.json.tmp');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadUsers() {
  ensureDataDir();
  if (fs.existsSync(USERS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch (e) {
      console.error('Failed to parse users.json, starting empty store:', e);
      return {};
    }
  }
  return {};
}

const users = loadUsers();

function saveUsers() {
  ensureDataDir();
  // Atomic write via temp file rename prevents corrupted JSON if interrupted
  fs.writeFileSync(TMP_FILE, JSON.stringify(users, null, 2), 'utf8');
  fs.renameSync(TMP_FILE, USERS_FILE);
}

function getTodayWIB() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
}

function getUser(userId) {
  const id = String(userId);
  const todayWIB = getTodayWIB();

  if (!users[id]) {
    users[id] = {
      quizCount: 0,
      lastQuizDate: todayWIB,
      premiumUntil: 0,
    };
  } else if (users[id].lastQuizDate !== todayWIB) {
    users[id].quizCount = 0;
    users[id].lastQuizDate = todayWIB;
  }

  return users[id];
}

function canTakeQuiz(userId) {
  const user = getUser(userId);
  const isPremium = typeof user.premiumUntil === 'number' && user.premiumUntil > Date.now();
  return isPremium || user.quizCount < DAILY_QUIZ_LIMIT;
}

function recordQuizUsage(userId) {
  const user = getUser(userId);
  user.quizCount += 1;
  user.lastQuizDate = getTodayWIB();
  saveUsers();
  return user;
}

function upgradeUser(userId, days) {
  const user = getUser(userId);
  const now = Date.now();
  const durationMs = Number(days) * MS_PER_DAY;

  if (typeof user.premiumUntil === 'number' && user.premiumUntil > now) {
    user.premiumUntil += durationMs;
  } else {
    user.premiumUntil = now + durationMs;
  }

  saveUsers();
  return user;
}

function getUserQuota(userId) {
  const user = getUser(userId);
  const isPremium = typeof user.premiumUntil === 'number' && user.premiumUntil > Date.now();
  const remaining = isPremium ? Infinity : Math.max(0, DAILY_QUIZ_LIMIT - user.quizCount);
  return {
    isPremium,
    premiumUntil: user.premiumUntil,
    used: user.quizCount,
    total: DAILY_QUIZ_LIMIT,
    remaining,
  };
}

module.exports = {
  DAILY_QUIZ_LIMIT,
  getTodayWIB,
  getUser,
  canTakeQuiz,
  recordQuizUsage,
  upgradeUser,
  getUserQuota,
};
