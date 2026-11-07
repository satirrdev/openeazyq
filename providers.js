require('dotenv').config();

const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;

const DATA_DIR = path.join(__dirname, 'data');
const PROVIDERS_FILE = path.join(DATA_DIR, 'providers.json');
const TMP_FILE = path.join(DATA_DIR, 'providers.json.tmp');

function parseIPv4(str) {
  if (!/^[\d.xa-fA-F]+$/.test(str)) return null;
  const parts = str.split('.');
  if (parts.length > 4 || parts.length < 1) return null;
  if (parts.some((p) => p.length === 0)) return null;
  const vals = [];
  for (const p of parts) {
    let v;
    if (/^0x[0-9a-f]+$/i.test(p)) v = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) v = parseInt(p, 8);
    else if (/^\d+$/.test(p)) v = parseInt(p, 10);
    else return null;
    if (isNaN(v) || v < 0) return null;
    vals.push(v);
  }
  let ip = 0;
  if (vals.length === 1) {
    if (vals[0] > 0xffffffff) return null;
    ip = vals[0];
  } else if (vals.length === 2) {
    if (vals[0] > 0xff || vals[1] > 0xffffff || vals[0] < 0) return null;
    ip = (vals[0] << 24) | vals[1];
  } else if (vals.length === 3) {
    if (vals[0] > 0xff || vals[1] > 0xff || vals[2] > 0xffff || vals[0] < 0 || vals[1] < 0) return null;
    ip = (vals[0] << 24) | (vals[1] << 16) | vals[2];
  } else if (vals.length === 4) {
    if (vals[0] > 0xff || vals[1] > 0xff || vals[2] > 0xff || vals[3] > 0xff) return null;
    ip = (vals[0] << 24) | (vals[1] << 16) | (vals[2] << 8) | vals[3];
  }
  return ip >>> 0;
}

function isPrivateIPv4(u) {
  if (typeof u !== 'number' || isNaN(u)) return false;
  if ((u >>> 24) === 0) return true; // 0.0.0.0/8
  if ((u >>> 24) === 10) return true; // 10.0.0.0/8
  if ((u >>> 24) === 127) return true; // 127.0.0.0/8
  if ((u >>> 20) === 0xac1) return true; // 172.16.0.0/12
  if ((u >>> 16) === 0xc0a8) return true; // 192.168.0.0/16
  if ((u >>> 16) === 0xa9fe) return true; // 169.254.0.0/16
  if ((u >>> 22) === 401) return true; // 100.64.0.0/10
  if (u === 0xffffffff) return true; // 255.255.255.255
  return false;
}

function isPrivateIPv6(str) {
  let s = str.replace(/^\[|\]$/g, '').trim().toLowerCase();
  let ipv4Part = null;
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':');
    if (lastColon === -1) return false;
    ipv4Part = s.slice(lastColon + 1);
    s = s.slice(0, lastColon) + ':0:0';
  }
  const doubleColon = s.indexOf('::');
  let words = [];
  if (doubleColon !== -1) {
    const left = s.slice(0, doubleColon);
    const right = s.slice(doubleColon + 2);
    const head = left ? left.split(':').map((x) => parseInt(x, 16)) : [];
    const tail = right ? right.split(':').map((x) => parseInt(x, 16)) : [];
    if (head.some(isNaN) || tail.some(isNaN)) return false;
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return false;
    words = [...head, ...Array(missing).fill(0), ...tail];
  } else {
    words = s.split(':').map((x) => parseInt(x, 16));
    if (words.length !== 8 || words.some(isNaN)) return false;
  }
  if (words.every((w) => w === 0)) return true;
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;
  if ((words[0] & 0xffc0) === 0xfe80) return true;
  if ((words[0] & 0xfe00) === 0xfc00) return true;
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    let ip4Int = null;
    if (ipv4Part) {
      ip4Int = parseIPv4(ipv4Part);
    } else {
      ip4Int = (((words[6] || 0) << 16) | (words[7] || 0)) >>> 0;
    }
    if (ip4Int !== null && isPrivateIPv4(ip4Int)) return true;
  }
  return false;
}

function isPrivateOrLoopbackHost(hostname) {
  if (!hostname || typeof hostname !== 'string') return true;
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.includes(']')) {
    h = h.slice(1, h.indexOf(']'));
  } else if (/^[^:]+:\d+$/.test(h)) {
    h = h.split(':')[0];
  }
  h = h.replace(/\.+$/, '');

  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === 'metadata.google.internal' || h.endsWith('.metadata.google.internal')) return true;
  if (h === 'metadata' || h === 'instance-data') return true;
  if (h === '0.0.0.0') return true;
  if (h.endsWith('.nip.io') || h.endsWith('.sslip.io') || h.endsWith('.local') || h.endsWith('.internal')) return true;

  const ip4 = parseIPv4(h);
  if (ip4 !== null) {
    return isPrivateIPv4(ip4);
  }

  return isPrivateIPv6(h);
}

function validateBaseURL(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('Field baseURL wajib diisi');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch (_) {
    throw new Error('Format baseURL tidak valid: bukan URL yang benar');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Protokol baseURL harus http: atau https:');
  }

  const bypass = process.env.NODE_ENV === 'test' || process.env.ALLOW_PRIVATE_AI_HOSTS === 'true';
  if (!bypass && isPrivateOrLoopbackHost(parsed.hostname)) {
    throw new Error('BaseURL tidak boleh mengarah ke localhost atau IP privat (SSRF protection)');
  }

  return rawUrl.trim();
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function seedDefaultProviders() {
  return [
    {
      id: 'provider_primary',
      name: 'Primary AI',
      type: 'openai',
      baseURL: process.env.AI_BASE_URL || 'https://tokenharbor.ai/v1',
      apiKey: process.env.AI_API_KEY || '',
      model: process.env.AI_MODEL_NAME || 'deepseek-v4.1-flash:free',
      supportsVision: true,
      enabled: true,
      status: 'active',
      lastChecked: 0,
      lastLatencyMs: 0,
      lastError: null,
      disabledUntil: 0,
    },
    {
      id: 'provider_fallback',
      name: 'Fallback AI',
      type: 'openai',
      baseURL: process.env.AI_BASE_URL || 'https://tokenharbor.ai/v1',
      apiKey: process.env.AI_API_KEY || '',
      model: process.env.AI_FALLBACK_MODEL_NAME || 'mimo-v2.6-flash:free',
      supportsVision: false,
      enabled: true,
      status: 'active',
      lastChecked: 0,
      lastLatencyMs: 0,
      lastError: null,
      disabledUntil: 0,
    },
  ];
}

function loadProviders() {
  ensureDataDir();
  if (fs.existsSync(PROVIDERS_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
      if (Array.isArray(data)) {
        return data;
      }
    } catch (e) {
      console.error('Failed to parse providers.json, reseeding default providers:', e);
    }
  }

  const defaultList = seedDefaultProviders();
  fs.writeFileSync(TMP_FILE, JSON.stringify(defaultList, null, 2), 'utf8');
  fs.renameSync(TMP_FILE, PROVIDERS_FILE);
  return defaultList;
}

let providers = loadProviders();

function saveProviders() {
  ensureDataDir();
  fs.writeFileSync(TMP_FILE, JSON.stringify(providers, null, 2), 'utf8');
  fs.renameSync(TMP_FILE, PROVIDERS_FILE);
}

function getProviders() {
  return providers.map((p) => ({ ...p }));
}

function getProvider(id) {
  const found = providers.find((p) => p.id === id);
  return found ? { ...found } : null;
}

function getActiveProviders(options = {}) {
  const now = Date.now();
  return providers
    .filter((p) => {
      if (!p.enabled) return false;
      if (typeof p.disabledUntil === 'number' && p.disabledUntil > now) return false;
      if (options.visionRequired && !p.supportsVision) return false;
      return true;
    })
    .map((p) => ({ ...p }));
}

function addProvider(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('Data provider harus berupa objek');
  }
  if (!data.name || typeof data.name !== 'string' || !data.name.trim()) {
    throw new Error('Field name wajib diisi');
  }
  if (!data.type || typeof data.type !== 'string' || !['openai', 'anthropic'].includes(data.type.trim().toLowerCase())) {
    throw new Error('Field type wajib diisi (openai atau anthropic)');
  }
  if (!data.baseURL || typeof data.baseURL !== 'string' || !data.baseURL.trim()) {
    throw new Error('Field baseURL wajib diisi');
  }
  if (!data.model || typeof data.model !== 'string' || !data.model.trim()) {
    throw new Error('Field model wajib diisi');
  }
  validateBaseURL(data.baseURL);

  const id = 'p_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const newProvider = {
    id,
    name: data.name.trim(),
    type: data.type.trim().toLowerCase(),
    baseURL: data.baseURL.trim(),
    apiKey: typeof data.apiKey === 'string' ? data.apiKey.trim() : '',
    model: data.model.trim(),
    supportsVision: Boolean(data.supportsVision),
    enabled: data.enabled !== undefined ? Boolean(data.enabled) : true,
    status: data.status || 'active',
    lastChecked: typeof data.lastChecked === 'number' ? data.lastChecked : 0,
    lastLatencyMs: typeof data.lastLatencyMs === 'number' ? data.lastLatencyMs : 0,
    lastError: data.lastError || null,
    disabledUntil: typeof data.disabledUntil === 'number' ? data.disabledUntil : 0,
  };

  providers.push(newProvider);
  saveProviders();
  return { ...newProvider };
}

function updateProvider(id, patch) {
  if (!id) {
    throw new Error('Provider ID wajib diisi');
  }
  if (!patch || typeof patch !== 'object') {
    throw new Error('Patch harus berupa objek');
  }

  const provider = providers.find((p) => p.id === id);
  if (!provider) {
    return null;
  }

  if (patch.baseURL !== undefined) {
    validateBaseURL(patch.baseURL);
  }

  for (const [key, val] of Object.entries(patch)) {
    if (key === 'id') continue;
    if (key === 'apiKey') {
      if (typeof val === 'string' && val.trim() !== '') {
        provider.apiKey = val.trim();
      }
      continue;
    }
    provider[key] = val;
  }

  saveProviders();
  return { ...provider };
}

function deleteProvider(id) {
  const index = providers.findIndex((p) => p.id === id);
  if (index === -1) {
    return false;
  }
  providers.splice(index, 1);
  saveProviders();
  return true;
}

function reorderProviders(orderedIds) {
  if (!Array.isArray(orderedIds)) {
    throw new Error('orderedIds harus berupa array of ID');
  }

  const idMap = new Map();
  for (const p of providers) {
    idMap.set(p.id, p);
  }

  const newOrder = [];
  for (const id of orderedIds) {
    if (idMap.has(id)) {
      newOrder.push(idMap.get(id));
      idMap.delete(id);
    }
  }

  for (const p of idMap.values()) {
    newOrder.push(p);
  }

  providers = newOrder;
  saveProviders();
  return providers.map((p) => ({ ...p }));
}

async function probeProvider(target) {
  if (!target) {
    throw new Error('Target provider cannot be empty');
  }

  const id = typeof target === 'string' ? target : target.id;
  const inStore = id ? providers.find((p) => p.id === id) : null;
  const p = inStore || (typeof target === 'object' ? target : null);

  if (!p) {
    throw new Error(`Provider ${id || 'unknown'} not found`);
  }

  const cleanBase = String(p.baseURL || '').trim().replace(/\/+$/, '');
  const isAnthropic = String(p.type || '').trim().toLowerCase() === 'anthropic';

  const url = isAnthropic ? `${cleanBase}/messages` : `${cleanBase}/chat/completions`;
  const headers = isAnthropic
    ? {
        'Content-Type': 'application/json',
        'x-api-key': p.apiKey || '',
        'anthropic-version': '2023-06-01',
      }
    : {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${p.apiKey || ''}`,
      };

  const body = isAnthropic
    ? JSON.stringify({
        model: p.model,
        max_tokens: 15,
        messages: [{ role: 'user', content: 'hello' }],
      })
    : JSON.stringify({
        model: p.model,
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 15,
      });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error('Request timed out after 120000ms'));
  }, 120000);

  const startTime = Date.now();
  let latencyMs = 0;

  try {
    const bypass = process.env.NODE_ENV === 'test' || process.env.ALLOW_PRIVATE_AI_HOSTS === 'true';
    if (!bypass) {
      const urlObj = new URL(url);
      if (isPrivateOrLoopbackHost(urlObj.hostname)) {
        throw new Error('SSRF blocked: host is private or loopback');
      }
      try {
        const records = await dns.lookup(urlObj.hostname, { all: true });
        for (const rec of records) {
          if (rec.family === 4) {
            const ip4 = parseIPv4(rec.address);
            if (ip4 !== null && isPrivateIPv4(ip4)) {
              throw new Error(`SSRF blocked: ${urlObj.hostname} resolves to private IP (${rec.address})`);
            }
          } else if (rec.family === 6) {
            if (isPrivateIPv6(rec.address)) {
              throw new Error(`SSRF blocked: ${urlObj.hostname} resolves to private IPv6 (${rec.address})`);
            }
          }
        }
      } catch (dnsErr) {
        if (dnsErr.message && dnsErr.message.startsWith('SSRF blocked:')) throw dnsErr;
      }
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    latencyMs = Date.now() - startTime;

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      let errMsg = `HTTP ${res.status}: ${res.statusText || 'Request failed'}`;
      if (errText) {
        try {
          const parsed = JSON.parse(errText);
          const detail = parsed.error?.message || parsed.message || (typeof parsed.error === 'string' ? parsed.error : null);
          if (detail) errMsg = `HTTP ${res.status}: ${detail}`;
        } catch {
          errMsg = `HTTP ${res.status}: ${errText.slice(0, 150)}`;
        }
      }
      throw new Error(errMsg);
    }

    const now = Date.now();
    p.status = 'active';
    p.lastLatencyMs = latencyMs;
    p.lastChecked = now;
    p.lastError = null;
    p.disabledUntil = 0;

    if (inStore && inStore !== p) {
      inStore.status = 'active';
      inStore.lastLatencyMs = latencyMs;
      inStore.lastChecked = now;
      inStore.lastError = null;
      inStore.disabledUntil = 0;
    }

    if (inStore) {
      saveProviders();
    }

    return { success: true, latencyMs };
  } catch (err) {
    latencyMs = Date.now() - startTime;
    const errorMsg = err && err.message ? err.message : 'Unknown error';
    const now = Date.now();

    p.status = 'quarantined';
    p.lastLatencyMs = latencyMs;
    p.lastChecked = now;
    p.lastError = errorMsg;
    p.disabledUntil = now + 3600000;

    if (inStore && inStore !== p) {
      inStore.status = 'quarantined';
      inStore.lastLatencyMs = latencyMs;
      inStore.lastChecked = now;
      inStore.lastError = errorMsg;
      inStore.disabledUntil = now + 3600000;
    }

    if (inStore) {
      saveProviders();
    }

    return { success: false, error: errorMsg, latencyMs };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function probeAllProviders() {
  const results = [];
  const enabledProviders = providers.filter((p) => p.enabled);
  for (const provider of enabledProviders) {
    try {
      const res = await probeProvider(provider);
      results.push({ id: provider.id, name: provider.name, ...res });
    } catch (err) {
      results.push({
        id: provider.id,
        name: provider.name,
        success: false,
        error: err && err.message ? err.message : 'Unknown error',
        latencyMs: 0,
      });
    }
  }
  return results;
}

let healthSchedulerInterval = null;

function startProviderHealthScheduler() {
  if (healthSchedulerInterval) {
    clearInterval(healthSchedulerInterval);
  }
  healthSchedulerInterval = setInterval(() => {
    probeAllProviders().catch((err) => {
      console.error('Error running hourly provider health check:', err);
    });
  }, 3600000);

  if (typeof healthSchedulerInterval.unref === 'function') {
    healthSchedulerInterval.unref();
  }
  return healthSchedulerInterval;
}

function stopProviderHealthScheduler() {
  if (healthSchedulerInterval) {
    clearInterval(healthSchedulerInterval);
    healthSchedulerInterval = null;
    return true;
  }
  return false;
}

function isHealthSchedulerRunning() {
  return healthSchedulerInterval !== null;
}

function reloadProviders() {
  providers = loadProviders();
  return getProviders();
}

module.exports = {
  DATA_DIR,
  PROVIDERS_FILE,
  isPrivateOrLoopbackHost,
  validateBaseURL,
  getProviders,
  getProvider,
  getActiveProviders,
  addProvider,
  updateProvider,
  deleteProvider,
  reorderProviders,
  probeProvider,
  probeAllProviders,
  startProviderHealthScheduler,
  stopProviderHealthScheduler,
  isHealthSchedulerRunning,
  reloadProviders,
  saveProviders,
};
