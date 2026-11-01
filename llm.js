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

// Helper to execute single model completion with timeout
async function executeModelCall(modelName, prompt, systemPrompt, opts = {}) {
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
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
      completion = await client.chat.completions.create(body, {
        signal: controller.signal,
        timeout: timeoutMs,
      });
    } catch (createErr) {
      // If provider rejects stop sequences, retry once without stop parameter
      if (body.stop && /stop/i.test(createErr.message || '')) {
        const bodyWithoutStop = { ...body };
        delete bodyWithoutStop.stop;
        completion = await client.chat.completions.create(bodyWithoutStop, {
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
    return content;
  } finally {
    clearTimeout(timer);
  }
}

// Call the LLM with primary DeepSeek model and optional fallback
async function ask(prompt, systemPrompt, opts = {}) {
  const primaryModel = opts.primaryModel || MODEL_DEEPSEEK;
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
