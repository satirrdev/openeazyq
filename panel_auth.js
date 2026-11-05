const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'panel_config.json');
const TMP_FILE = path.join(DATA_DIR, 'panel_config.json.tmp');
const SESSION_TTL_MS = 86400000; // 24 hours

const sessions = new Map();
let cachedConfig = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function savePanelConfig(cfg) {
  ensureDataDir();
  fs.writeFileSync(TMP_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(TMP_FILE, CONFIG_FILE);
  cachedConfig = cfg;
}

function loadPanelConfig() {
  ensureDataDir();
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed.salt === 'string' &&
        (typeof parsed.passwordHash === 'string' || typeof parsed.hash === 'string')
      ) {
        cachedConfig = parsed;
        return cachedConfig;
      }
    } catch (err) {
      console.error('Failed to parse panel_config.json, reinitializing default:', err.message || err);
    }
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword('123456', salt);
  const defaultConfig = {
    salt,
    passwordHash: hash,
    hash,
    updatedAt: Date.now(),
  };
  savePanelConfig(defaultConfig);
  return defaultConfig;
}

function getConfig() {
  if (!cachedConfig || !fs.existsSync(CONFIG_FILE)) {
    cachedConfig = loadPanelConfig();
  }
  return cachedConfig;
}

function verifyPassword(inputPassword) {
  if (typeof inputPassword !== 'string' || inputPassword.length === 0) {
    return false;
  }

  const cfg = getConfig();
  const salt = cfg?.salt;
  const storedHash = cfg?.passwordHash || cfg?.hash;

  if (!salt || !storedHash) {
    return false;
  }

  try {
    const computedHash = hashPassword(inputPassword, salt);
    const computedBuf = Buffer.from(computedHash, 'hex');
    const storedBuf = Buffer.from(storedHash, 'hex');

    if (computedBuf.length !== storedBuf.length) {
      return false;
    }

    return crypto.timingSafeEqual(computedBuf, storedBuf);
  } catch (_) {
    return false;
  }
}

function changePassword(newPassword) {
  if (typeof newPassword !== 'string' || newPassword.length < 4) {
    throw new Error('New password must be a string with at least 4 characters');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(newPassword, salt);
  const newConfig = {
    salt,
    passwordHash: hash,
    hash,
    updatedAt: Date.now(),
  };

  savePanelConfig(newConfig);
  sessions.clear();

  return { success: true };
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(token, {
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
  return token;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') {
    return false;
  }

  const session = sessions.get(token);
  if (!session) {
    return false;
  }

  if (Date.now() >= session.expiresAt) {
    sessions.delete(token);
    return false;
  }

  return true;
}

function deleteSession(token) {
  if (!token || typeof token !== 'string') {
    return false;
  }
  return sessions.delete(token);
}

function extractSessionToken(req) {
  if (!req || typeof req !== 'object' || !req.headers) {
    return null;
  }

  // 1. Look for cookie admin_session=<token> in req.headers.cookie
  if (typeof req.headers.cookie === 'string') {
    const cookieMatch = req.headers.cookie.match(/(?:^|;\s*)admin_session=([^;]+)/);
    if (cookieMatch && cookieMatch[1]) {
      let token = cookieMatch[1].trim().replace(/^"|"$/g, '');
      try {
        token = decodeURIComponent(token);
      } catch (_) {}
      if (token) {
        return token;
      }
    }
  }

  // 2. Look for Authorization: Bearer <token> in req.headers.authorization
  if (typeof req.headers.authorization === 'string') {
    const authHeader = req.headers.authorization.trim();
    const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
    if (bearerMatch && bearerMatch[1]) {
      const token = bearerMatch[1].trim();
      if (token) {
        return token;
      }
    }
  }

  return null;
}

// Initial configuration load upon module initialization
cachedConfig = loadPanelConfig();

module.exports = {
  verifyPassword,
  changePassword,
  createSession,
  verifySession,
  deleteSession,
  extractSessionToken,
  loadPanelConfig,
  getConfig,
  sessions,
  SESSION_TTL_MS,
  CONFIG_FILE,
};
