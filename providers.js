require('dotenv').config();

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const PROVIDERS_FILE = path.join(DATA_DIR, 'providers.json');
const TMP_FILE = path.join(DATA_DIR, 'providers.json.tmp');

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
