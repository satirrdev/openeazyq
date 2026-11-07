const fs = require('fs');
const path = require('path');

const DAILY_QUIZ_LIMIT = 5;
const DAILY_EXPLAIN_LIMIT = 15;
const DAILY_IMAGE_LIMIT = 5;
const MS_PER_DAY = 86400000;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TMP_FILE = path.join(DATA_DIR, 'users.json.tmp');

let globalLimits = {
  quiz: DAILY_QUIZ_LIMIT,
  explain: DAILY_EXPLAIN_LIMIT,
  image: DAILY_IMAGE_LIMIT,
};

function loadLimitsFromConfig() {
  const configPath = path.join(DATA_DIR, 'panel_config.json');
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (cfg && typeof cfg.limits === 'object' && cfg.limits !== null) {
        globalLimits = {
          quiz: cfg.limits.quiz !== undefined ? parseLimit(cfg.limits.quiz, DAILY_QUIZ_LIMIT) : DAILY_QUIZ_LIMIT,
          explain: cfg.limits.explain !== undefined ? parseLimit(cfg.limits.explain, DAILY_EXPLAIN_LIMIT) : DAILY_EXPLAIN_LIMIT,
          image: cfg.limits.image !== undefined ? parseLimit(cfg.limits.image, DAILY_IMAGE_LIMIT) : DAILY_IMAGE_LIMIT,
        };
      }
    } catch (_) {}
  }
}

function parseLimit(val, fallback) {
  if (val === null || val === 'unlimited' || val === 'infinity' || val === Infinity || val === -1 || val === '-1') {
    return Infinity;
  }
  if (val === '' || val === undefined) {
    return fallback;
  }
  const n = Number(val);
  return !isNaN(n) && n >= 0 ? Math.floor(n) : fallback;
}

loadLimitsFromConfig();

function getGlobalLimits() {
  loadLimitsFromConfig();
  return { ...globalLimits };
}

function setGlobalLimits(limits) {
  if (!limits || typeof limits !== 'object') {
    throw new Error('Limits harus berupa objek');
  }
  const configPath = path.join(DATA_DIR, 'panel_config.json');
  const tmpPath = path.join(DATA_DIR, 'panel_config.json.tmp');
  let cfg = {};
  if (fs.existsSync(configPath)) {
    try {
      cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (_) {}
  }

  const updatedLimits = {
    quiz: limits.quiz !== undefined ? parseLimit(limits.quiz, DAILY_QUIZ_LIMIT) : globalLimits.quiz,
    explain: limits.explain !== undefined ? parseLimit(limits.explain, DAILY_EXPLAIN_LIMIT) : globalLimits.explain,
    image: limits.image !== undefined ? parseLimit(limits.image, DAILY_IMAGE_LIMIT) : globalLimits.image,
  };

  cfg.limits = updatedLimits;
  globalLimits = updatedLimits;

  ensureDataDir();
  fs.writeFileSync(tmpPath, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmpPath, configPath);
  return { ...globalLimits };
}

function getQuizLimit(userId) {
  loadLimitsFromConfig();
  const id = String(userId);
  if (userId && users[id]?.customLimits?.quiz !== undefined) {
    return parseLimit(users[id].customLimits.quiz, DAILY_QUIZ_LIMIT);
  }
  return parseLimit(globalLimits.quiz, DAILY_QUIZ_LIMIT);
}

function getExplainLimit(userId) {
  loadLimitsFromConfig();
  const id = String(userId);
  if (userId && users[id]?.customLimits?.explain !== undefined) {
    return parseLimit(users[id].customLimits.explain, DAILY_EXPLAIN_LIMIT);
  }
  return parseLimit(globalLimits.explain, DAILY_EXPLAIN_LIMIT);
}

function getImageLimit(userId) {
  loadLimitsFromConfig();
  const id = String(userId);
  if (userId && users[id]?.customLimits?.image !== undefined) {
    return parseLimit(users[id].customLimits.image, DAILY_IMAGE_LIMIT);
  }
  return parseLimit(globalLimits.image, DAILY_IMAGE_LIMIT);
}

function setUserLimits(userId, limits) {
  const user = getUser(userId);
  if (limits === null) {
    delete user.customLimits;
    saveUsers();
    return user;
  }

  if (!user.customLimits) {
    user.customLimits = {};
  }

  const applyField = (field, fallback) => {
    if (limits[field] === undefined) return;
    const v = typeof limits[field] === 'string' ? limits[field].trim().toLowerCase() : limits[field];
    if (v === '' || v === null) {
      delete user.customLimits[field];
    } else if (v === 'unlimited' || v === 'infinity' || v === Infinity || v === -1 || v === '-1') {
      user.customLimits[field] = 'unlimited';
    } else {
      const n = Number(v);
      if (!isNaN(n) && n >= 0) {
        user.customLimits[field] = Math.floor(n);
      }
    }
  };

  applyField('quiz', DAILY_QUIZ_LIMIT);
  applyField('explain', DAILY_EXPLAIN_LIMIT);
  applyField('image', DAILY_IMAGE_LIMIT);

  if (Object.keys(user.customLimits).length === 0) {
    delete user.customLimits;
  }
  saveUsers();
  return user;
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

let lastUsersFileMtime = 0;

function syncUsersFromDisk() {
  ensureDataDir();
  if (!fs.existsSync(USERS_FILE)) return;
  try {
    const stat = fs.statSync(USERS_FILE);
    if (stat.mtimeMs > lastUsersFileMtime) {
      const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
      if (data && typeof data === 'object') {
        for (const k of Object.keys(users)) {
          if (!data[k]) delete users[k];
        }
        for (const [k, v] of Object.entries(data)) {
          users[k] = v;
        }
        lastUsersFileMtime = stat.mtimeMs;
      }
    }
  } catch (_) {}
}

function loadUsers() {
  ensureDataDir();
  if (fs.existsSync(USERS_FILE)) {
    try {
      lastUsersFileMtime = fs.statSync(USERS_FILE).mtimeMs;
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
  fs.writeFileSync(TMP_FILE, JSON.stringify(users, null, 2), 'utf8');
  fs.renameSync(TMP_FILE, USERS_FILE);
  try {
    lastUsersFileMtime = fs.statSync(USERS_FILE).mtimeMs;
  } catch (_) {}
}

function getTodayWIB() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());
}

function getUser(userId) {
  syncUsersFromDisk();
  const id = String(userId);
  const todayWIB = getTodayWIB();

  if (!users[id]) {
    users[id] = {
      quizCount: 0,
      explainCount: 0,
      imageCount: 0,
      lastQuizDate: todayWIB,
      premiumUntil: 0,
      language: 'en',
    };
    saveUsers();
  } else if (users[id].lastQuizDate !== todayWIB) {
    users[id].quizCount = 0;
    users[id].explainCount = 0;
    users[id].imageCount = 0;
    users[id].lastQuizDate = todayWIB;
    saveUsers();
  }

  // Defensive defaults for existing user records
  if (typeof users[id].explainCount !== 'number') users[id].explainCount = 0;
  if (typeof users[id].imageCount !== 'number') users[id].imageCount = 0;
  if (!users[id].language) users[id].language = 'en';

  return users[id];
}

const pendingQuiz = new Map();
const pendingExplain = new Map();
const pendingImage = new Map();

function reserveQuota(userId, type = 'quiz') {
  const map = type === 'quiz' ? pendingQuiz : (type === 'explain' ? pendingExplain : pendingImage);
  const id = String(userId);
  map.set(id, (map.get(id) || 0) + 1);
}

function releaseQuota(userId, type = 'quiz') {
  const map = type === 'quiz' ? pendingQuiz : (type === 'explain' ? pendingExplain : pendingImage);
  const id = String(userId);
  const cur = map.get(id) || 0;
  if (cur <= 1) {
    map.delete(id);
  } else {
    map.set(id, cur - 1);
  }
}

function canTakeQuiz(userId) {
  const user = getUser(userId);
  const isPremium = typeof user.premiumUntil === 'number' && user.premiumUntil > Date.now();
  const limit = getQuizLimit(userId);
  const inFlight = pendingQuiz.get(String(userId)) || 0;
  return isPremium || limit === Infinity || (user.quizCount + inFlight) < limit;
}

function canExplain(userId) {
  const user = getUser(userId);
  const isPremium = typeof user.premiumUntil === 'number' && user.premiumUntil > Date.now();
  const limit = getExplainLimit(userId);
  const inFlight = pendingExplain.get(String(userId)) || 0;
  return isPremium || limit === Infinity || (user.explainCount + inFlight) < limit;
}

function canUploadImage(userId) {
  const user = getUser(userId);
  const isPremium = typeof user.premiumUntil === 'number' && user.premiumUntil > Date.now();
  const limit = getImageLimit(userId);
  const inFlight = pendingImage.get(String(userId)) || 0;
  return isPremium || limit === Infinity || (user.imageCount + inFlight) < limit;
}

function getUserLanguage(userId) {
  const user = getUser(userId);
  return user.language === 'id' ? 'id' : 'en';
}

function setUserLanguage(userId, lang) {
  const cleanLang = String(lang).toLowerCase() === 'id' ? 'id' : 'en';
  const user = getUser(userId);
  user.language = cleanLang;
  saveUsers();
  return cleanLang;
}

function recordQuizUsage(userId) {
  releaseQuota(userId, 'quiz');
  const user = getUser(userId);
  user.quizCount += 1;
  user.lastQuizDate = getTodayWIB();
  saveUsers();
  return user;
}

function recordExplainUsage(userId) {
  releaseQuota(userId, 'explain');
  const user = getUser(userId);
  user.explainCount += 1;
  user.lastQuizDate = getTodayWIB();
  saveUsers();
  return user;
}

function recordImageUsage(userId) {
  releaseQuota(userId, 'image');
  const user = getUser(userId);
  user.imageCount += 1;
  user.lastQuizDate = getTodayWIB();
  saveUsers();
  return user;
}

function addPremiumDays(userId, days) {
  const user = getUser(userId);
  const now = Date.now();
  const d = Number(days);
  if (isNaN(d) || d <= 0) {
    user.premiumUntil = 0;
    saveUsers();
    return user;
  }
  const durationMs = d * MS_PER_DAY;
  if (typeof user.premiumUntil === 'number' && user.premiumUntil > now) {
    user.premiumUntil += durationMs;
  } else {
    user.premiumUntil = now + durationMs;
  }
  saveUsers();
  return user;
}

function revokePremium(userId) {
  const user = getUser(userId);
  user.premiumUntil = 0;
  saveUsers();
  return user;
}

function upgradeUser(userId, days) {
  return addPremiumDays(userId, days);
}

function resetUserQuota(userId, type = 'all') {
  const user = getUser(userId);
  const targetType = String(type || 'all').toLowerCase();

  if (targetType === 'quiz') {
    user.quizCount = 0;
  } else if (targetType === 'explain') {
    user.explainCount = 0;
  } else if (targetType === 'image') {
    user.imageCount = 0;
  } else {
    user.quizCount = 0;
    user.explainCount = 0;
    user.imageCount = 0;
  }

  user.lastQuizDate = getTodayWIB();
  saveUsers();
  return user;
}

function deleteUser(userId) {
  const id = String(userId);
  if (Object.prototype.hasOwnProperty.call(users, id)) {
    delete users[id];
    saveUsers();
    return true;
  }
  return false;
}

function getAllUsers() {
  syncUsersFromDisk();
  const userIds = Object.keys(users);
  return userIds.map((id) => {
    const user = getUser(id);
    const isPremium = typeof user.premiumUntil === 'number' && user.premiumUntil > Date.now();
    const d = new Date(user.premiumUntil);
    const isValidDate = !isNaN(d.getTime());
    const formattedJakartaExpiry = typeof user.premiumUntil === 'number' && user.premiumUntil > 0 && isValidDate
      ? d.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
      : null;

    const quizLimit = getQuizLimit(id);
    const explainLimit = getExplainLimit(id);
    const imageLimit = getImageLimit(id);

    return {
      userId: id,
      quizCount: user.quizCount,
      explainCount: user.explainCount,
      imageCount: user.imageCount,
      lastQuizDate: user.lastQuizDate,
      premiumUntil: user.premiumUntil,
      isPremium,
      formattedJakartaExpiry,
      customLimits: user.customLimits || null,
      quizLimit: quizLimit === Infinity ? 'unlimited' : quizLimit,
      explainLimit: explainLimit === Infinity ? 'unlimited' : explainLimit,
      imageLimit: imageLimit === Infinity ? 'unlimited' : imageLimit,
    };
  });
}

function getUserQuota(userId) {
  const user = getUser(userId);
  const isPremium = typeof user.premiumUntil === 'number' && user.premiumUntil > Date.now();
  const quizLimit = getQuizLimit(userId);
  const explainLimit = getExplainLimit(userId);
  const imageLimit = getImageLimit(userId);

  const remainingQuiz = isPremium || quizLimit === Infinity ? Infinity : Math.max(0, quizLimit - user.quizCount);
  const remainingExplain = isPremium || explainLimit === Infinity ? Infinity : Math.max(0, explainLimit - user.explainCount);
  const remainingImage = isPremium || imageLimit === Infinity ? Infinity : Math.max(0, imageLimit - user.imageCount);
  return {
    isPremium,
    premiumUntil: user.premiumUntil,
    used: user.quizCount,
    total: quizLimit === Infinity ? Infinity : quizLimit,
    remaining: remainingQuiz,
    quiz: {
      used: user.quizCount,
      total: quizLimit === Infinity ? Infinity : quizLimit,
      remaining: remainingQuiz,
    },
    explain: {
      used: user.explainCount,
      total: explainLimit === Infinity ? Infinity : explainLimit,
      remaining: remainingExplain,
    },
    image: {
      used: user.imageCount,
      total: imageLimit === Infinity ? Infinity : imageLimit,
      remaining: remainingImage,
    },
  };
}

module.exports = {
  DAILY_QUIZ_LIMIT,
  DAILY_EXPLAIN_LIMIT,
  DAILY_IMAGE_LIMIT,
  getGlobalLimits,
  setGlobalLimits,
  setUserLimits,
  getQuizLimit,
  getExplainLimit,
  getImageLimit,
  getTodayWIB,
  getUser,
  canTakeQuiz,
  canExplain,
  canUploadImage,
  reserveQuota,
  releaseQuota,
  recordQuizUsage,
  recordExplainUsage,
  recordImageUsage,
  upgradeUser,
  addPremiumDays,
  revokePremium,
  resetUserQuota,
  deleteUser,
  getAllUsers,
  getUserQuota,
  getUserLanguage,
  setUserLanguage,
};
