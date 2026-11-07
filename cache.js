// cache.js - Zero-dependency in-memory response & token cache for GampangBot
const crypto = require('crypto');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 500;

class ResponseCache {
  constructor(maxEntries = MAX_ENTRIES, defaultTtlMs = DEFAULT_TTL_MS) {
    this.maxEntries = maxEntries;
    this.defaultTtlMs = defaultTtlMs;
    this.map = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      savedTokensEstimate: 0,
    };
  }

  makeKey(type, lang, content) {
    const raw = `${type}:::${lang || 'en'}:::${String(content || '').trim().toLowerCase()}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  get(key) {
    if (!this.map.has(key)) {
      this.stats.misses++;
      return null;
    }

    const entry = this.map.get(key);
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    // Estimate tokens saved: ~4 chars per token
    const tokenEst =
      typeof entry.value === 'string'
        ? Math.ceil(entry.value.length / 4)
        : entry.value
        ? Math.ceil(JSON.stringify(entry.value).length / 4)
        : 100;
    this.stats.savedTokensEstimate += tokenEst;
    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTtlMs) {
    if (this.map.size >= this.maxEntries) {
      // Evict oldest entry (FIFO in JS Map)
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }

    this.map.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  has(key) {
    return this.get(key) !== null;
  }

  del(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  getStats() {
    return {
      size: this.map.size,
      ...this.stats,
    };
  }
}

const responseCache = new ResponseCache();

module.exports = {
  responseCache,
  ResponseCache,
};
