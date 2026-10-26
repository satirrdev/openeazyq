require('dotenv').config();

const OpenAI = require('openai');

const TIMEOUT_MS = 90000;
const ERROR_MSG = 'Server AI lagi sibuk nih, coba kirim ulang materi lu bentar lagi ya.';

const client = new OpenAI({
  apiKey: process.env.AI_API_KEY,
  baseURL: process.env.AI_BASE_URL,
  timeout: TIMEOUT_MS,
  // Network to this endpoint can be flaky (TLS drops mid-handshake)
  maxRetries: 2,
});

const PRIMARY_MODEL = process.env.AI_MODEL_NAME || 'deepseek-v4.1-flash:free';
const FALLBACK_MODEL = process.env.AI_FALLBACK_MODEL_NAME || 'mimo-v2.6-flash:free';

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

// Try to extract the first valid JSON object from raw LLM output with auto-repair
function extractJson(raw) {
  const cleaned = stripFences(raw);
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Fallback: grab from first { to last }
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      const slice = cleaned.slice(start, end + 1);
      try {
        return JSON.parse(slice);
      } catch (e2) {
        // Auto-repair: remove trailing commas before closing braces/brackets
        try {
          const repaired = slice.replace(/,\s*([}\]])/g, '$1');
          return JSON.parse(repaired);
        } catch (e3) {
          throw e;
        }
      }
    }
    throw e;
  }
}

// Helper to execute single model completion with timeout
async function executeModelCall(modelName, prompt, systemPrompt, opts = {}) {
  const timeoutMs = opts.timeoutMs || TIMEOUT_MS;
  const body = {
    model: modelName,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt },
    ],
    temperature: 0.7,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const completion = await client.chat.completions.create(body, {
      signal: controller.signal,
    });
    return completion.choices[0].message.content || '';
  } finally {
    clearTimeout(timer);
  }
}

// Call the LLM with automatic fallback from Primary to Fallback model
async function ask(prompt, systemPrompt, opts = {}) {
  try {
    return await executeModelCall(PRIMARY_MODEL, prompt, systemPrompt, opts);
  } catch (primaryErr) {
    if (FALLBACK_MODEL && FALLBACK_MODEL !== PRIMARY_MODEL) {
      console.warn(
        `[LLM Fallback] Primary model "${PRIMARY_MODEL}" failed (${primaryErr.message}). Retrying with fallback "${FALLBACK_MODEL}"...`
      );
      try {
        return await executeModelCall(FALLBACK_MODEL, prompt, systemPrompt, opts);
      } catch (fallbackErr) {
        console.error(`[LLM Fallback] Fallback model "${FALLBACK_MODEL}" also failed:`, fallbackErr.message);
        throw fallbackErr;
      }
    }
    throw primaryErr;
  }
}

module.exports = { ask, extractJson, stripFences, ERROR_MSG, MODEL: PRIMARY_MODEL, FALLBACK_MODEL };
