require('dotenv').config();

const OpenAI = require('openai');

const TIMEOUT_MS = 75000;
const ERROR_MSG = 'Server AI lagi sibuk nih, coba kirim ulang materi lu bentar lagi ya.';

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL,
  timeout: TIMEOUT_MS,
  // Disable SDK hidden retries so request deadlines and failovers are immediate
  maxRetries: 0,
});

const MODEL_DEEPSEEK = process.env.AI_MODEL_NAME || 'deepseek-v4.1-flash:free';
const MODEL_MIMO = process.env.AI_FALLBACK_MODEL_NAME || 'mimo-v2.6-flash:free';
const PRIMARY_MODEL = MODEL_DEEPSEEK;
const FALLBACK_MODEL = MODEL_MIMO;

// Strip accidental markdown fences like ```json ... ```
function stripFences(text) {
  if (!text) return '';
  let out = text.trim();
  // Remove leading fence (```json / ```  etc.)
  out = out.replace(/^```[a-zA-Z]*\s*/, '');
  // Remove trailing fence
  out = out.replace(/```\s*$/, '');
  return out.trim();
}

// Auto-repair truncated JSON where output was cut off mid-sentence or mid-object
function repairTruncatedJson(str) {
  let inString = false;
  let escaped = false;
  const openStack = [];
  let parenDepthInString = 0;
  let repaired = '';

  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (inString) {
      repaired += c;
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      } else if (c === '(') {
        parenDepthInString++;
      } else if (c === ')') {
        if (parenDepthInString > 0) parenDepthInString--;
      }
    } else {
      if (c === '"') {
        inString = true;
        parenDepthInString = 0;
        repaired += c;
      } else if (c === '{' || c === '[') {
        openStack.push(c);
        repaired += c;
      } else if (c === '}') {
        if (openStack.length > 0 && openStack[openStack.length - 1] === '{') {
          openStack.pop();
        }
        repaired += c;
      } else if (c === ']') {
        if (openStack.length > 0 && openStack[openStack.length - 1] === '[') {
          openStack.pop();
        }
        repaired += c;
      } else if (c === ')') {
        // If stray closing parenthesis is outside string instead of closing brace, ignore
        if (openStack.length > 0 && openStack[openStack.length - 1] === '{') {
          continue;
        }
        repaired += c;
      } else {
        repaired += c;
      }
    }
  }

  // If text was cut off while still inside a string literal
  if (inString) {
    if (parenDepthInString > 0) {
      repaired += ')'.repeat(parenDepthInString);
    }
    repaired += '"';
  }

  // Trim trailing whitespace, stray colons, or commas before closing
  repaired = repaired.replace(/[:,\s]+$/, '');

  // Close any unclosed braces or brackets in reverse order
  while (openStack.length > 0) {
    const top = openStack.pop();
    if (top === '{') repaired += '}';
    else if (top === '[') repaired += ']';
  }

  // Remove trailing commas before closing braces/brackets
  return repaired.replace(/,\s*([}\]])/g, '$1');
}

// Try to extract the first valid JSON object from raw LLM output with auto-repair
function extractJson(raw) {
  const cleaned = stripFences(raw);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const start = cleaned.indexOf('{');
    if (start === -1) throw e;

    const end = cleaned.lastIndexOf('}');
    if (end > start) {
      const slice = cleaned.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch (e2) {
        try {
          const repaired = slice.replace(/,\s*([}\]])/g, '$1');
          return JSON.parse(repaired);
        } catch (e3) {
          // Fall through to truncation repair
        }
      }
    }

    // Truncation repair for cut-off JSON
    try {
      const fromStart = cleaned.slice(start);
      const repaired = repairTruncatedJson(fromStart);
      return JSON.parse(repaired);
    } catch (e4) {
      throw e;
    }
  }
}

const clientPool = new Map();
function getOpenAIClient(baseURL, apiKey, timeoutMs = TIMEOUT_MS) {
  if (
    (!baseURL || baseURL === process.env.AI_BASE_URL) &&
    (!apiKey || apiKey === process.env.AI_API_KEY)
  ) {
    return client;
  }
  const key = `${baseURL}:::${apiKey}`;
  if (!clientPool.has(key)) {
    clientPool.set(
      key,
      new OpenAI({
        baseURL: baseURL || process.env.AI_BASE_URL,
        apiKey: apiKey || process.env.AI_API_KEY,
        timeout: timeoutMs,
        maxRetries: 0,
      })
    );
  }
  return clientPool.get(key);
}

// Helper to execute single model completion with timeout
async function executeModelCall(modelName, prompt, systemPrompt, opts = {}) {
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const activeClient = opts.client || client;
  const userContent = opts.imageBase64
    ? [
        { type: 'text', text: prompt || 'Analisis materi pada gambar berikut:' },
        { type: 'image_url', image_url: { url: opts.imageBase64 } },
      ]
    : prompt;

  const messages = [{ role: 'system', content: systemPrompt }];

  if (Array.isArray(opts.history) && opts.history.length > 0) {
    for (const h of opts.history) {
      if (
        h &&
        (h.role === 'user' || h.role === 'assistant') &&
        typeof h.content === 'string' &&
        h.content.trim()
      ) {
        messages.push({ role: h.role, content: h.content.trim() });
      }
    }
  }

  messages.push({ role: 'user', content: userContent });

  const body = {
    model: modelName,
    messages,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (Array.isArray(opts.stop) && opts.stop.length > 0) {
    body.stop = opts.stop;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let completion;
    try {
      completion = await activeClient.chat.completions.create(body, {
        signal: controller.signal,
        timeout: timeoutMs,
      });
    } catch (createErr) {
      // If provider rejects stop sequences, retry once without stop parameter
      if (body.stop && /stop/i.test(createErr.message || '')) {
        const bodyWithoutStop = { ...body };
        delete bodyWithoutStop.stop;
        completion = await activeClient.chat.completions.create(bodyWithoutStop, {
          signal: controller.signal,
          timeout: timeoutMs,
        });
      } else {
        throw createErr;
      }
    }
    const choice = completion.choices && completion.choices[0];
    const message = choice && choice.message;
    const content = message && typeof message.content === 'string' ? message.content.trim() : '';
    if (!content) {
      throw new Error(`Model ${modelName} returned empty response`);
    }
    if (completion.usage) {
      const cached =
        completion.usage.prompt_tokens_details?.cached_tokens ||
        completion.usage.cache_read_input_tokens ||
        0;
      if (cached > 0 && typeof opts.onCachedTokens === 'function') {
        opts.onCachedTokens(cached);
      }
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

// Helper to execute Anthropic API call with timeout
async function executeAnthropicCall(provider, prompt, systemPrompt, opts = {}) {
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const cleanBase = String(provider.baseURL || 'https://api.anthropic.com/v1').trim().replace(/\/+$/, '');
  const url = `${cleanBase}/messages`;

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': provider.apiKey || '',
    'anthropic-version': '2023-06-01',
  };

  const messages = [];
  if (Array.isArray(opts.history) && opts.history.length > 0) {
    for (const h of opts.history) {
      if (
        h &&
        (h.role === 'user' || h.role === 'assistant') &&
        typeof h.content === 'string' &&
        h.content.trim()
      ) {
        messages.push({ role: h.role, content: h.content.trim() });
      }
    }
  }

  let userContent;
  if (opts.imageBase64) {
    let mimeType = 'image/jpeg';
    let base64Data = opts.imageBase64;
    const match = opts.imageBase64.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      mimeType = match[1];
      base64Data = match[2];
    }
    userContent = [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mimeType,
          data: base64Data,
        },
      },
      {
        type: 'text',
        text: prompt || 'Analisis materi pada gambar berikut:',
      },
    ];
  } else {
    userContent = prompt;
  }

  messages.push({ role: 'user', content: userContent });

  const body = {
    model: provider.model,
    max_tokens: opts.maxTokens || 2048,
    messages,
  };
  if (systemPrompt) {
    body.system = [
      {
        type: 'text',
        text: systemPrompt,
        cache_control: { type: 'ephemeral' },
      },
    ];
  }
  if (typeof opts.temperature === 'number') {
    body.temperature = opts.temperature;
  }
  if (Array.isArray(opts.stop) && opts.stop.length > 0) {
    body.stop_sequences = opts.stop;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Anthropic HTTP ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const textBlock = Array.isArray(data.content) ? data.content.find((c) => c.type === 'text') : null;
    const content = textBlock && textBlock.text ? textBlock.text.trim() : '';
    if (!content) {
      throw new Error(`Anthropic model ${provider.model} returned empty response`);
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

// Call the LLM with dynamic multi-provider fallback or specific model override
async function ask(prompt, systemPrompt, opts = {}) {
  // If specific models are passed (e.g. from unit tests), preserve legacy two-model routing
  if (opts.primaryModel) {
    const primaryModel = opts.primaryModel;
    const fallbackModel = opts.fallbackModel !== undefined ? opts.fallbackModel : MODEL_MIMO;

    try {
      return await executeModelCall(primaryModel, prompt, systemPrompt, opts);
    } catch (primaryErr) {
      // Skip fallback when image is attached because text-only models cannot process vision
      if (opts.imageBase64) {
        throw primaryErr;
      }
      if (fallbackModel && fallbackModel !== primaryModel) {
        console.warn(
          `[LLM Fallback] Primary model "${primaryModel}" failed (${primaryErr.message}). Retrying with fallback "${fallbackModel}"...`
        );
        try {
          return await executeModelCall(fallbackModel, prompt, systemPrompt, opts);
        } catch (fallbackErr) {
          console.error(`[LLM Fallback] Fallback model "${fallbackModel}" also failed:`, fallbackErr.message);
          throw fallbackErr;
        }
      }
      throw primaryErr;
    }
  }

  // Dynamic multi-provider fallback chain from providers.js
  let candidates = [];
  try {
    const providersModule = require('./providers');
    candidates = providersModule.getActiveProviders({ visionRequired: Boolean(opts.imageBase64) });
  } catch (_) {}

  // Fallback if no providers are registered or module unavailable
  if (!candidates || candidates.length === 0) {
    candidates = [
      {
        id: 'provider_primary',
        name: 'Primary AI',
        type: 'openai',
        baseURL: process.env.AI_BASE_URL,
        apiKey: process.env.AI_API_KEY,
        model: MODEL_DEEPSEEK,
        supportsVision: true,
      },
      ...(!opts.imageBase64
        ? [
            {
              id: 'provider_fallback',
              name: 'Fallback AI',
              type: 'openai',
              baseURL: process.env.AI_BASE_URL,
              apiKey: process.env.AI_API_KEY,
              model: MODEL_MIMO,
              supportsVision: false,
            },
          ]
        : []),
    ];
  }

  let lastError = null;
  for (let i = 0; i < candidates.length; i++) {
    const provider = candidates[i];
    try {
      if (provider.type === 'anthropic') {
        return await executeAnthropicCall(provider, prompt, systemPrompt, opts);
      } else {
        const targetClient = getOpenAIClient(provider.baseURL, provider.apiKey, opts.timeoutMs || TIMEOUT_MS);
        return await executeModelCall(provider.model, prompt, systemPrompt, { ...opts, client: targetClient });
      }
    } catch (err) {
      lastError = err;
      console.warn(`[AI Engine] Provider "${provider.name || provider.model}" failed (${err.message}). Trying next provider...`);
    }
  }

  console.error(`[AI Engine] All active AI providers failed. Last error: ${lastError?.message}`);
  throw new Error(ERROR_MSG);
}

module.exports = {
  ask,
  extractJson,
  stripFences,
  ERROR_MSG,
  MODEL: PRIMARY_MODEL,
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  MODEL_DEEPSEEK,
  MODEL_MIMO,
};
