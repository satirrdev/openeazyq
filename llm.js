require('dotenv').config();

const OpenAI = require('openai');

const TIMEOUT_MS = 45000;
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
  const userContent = opts.imageBase64
    ? [
        { type: 'text', text: prompt || 'Analisis materi pada gambar berikut:' },
        { type: 'image_url', image_url: { url: opts.imageBase64 } },
      ]
    : prompt;

  const body = {
    model: modelName,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.7,
  };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const completion = await client.chat.completions.create(body, {
      signal: controller.signal,
      timeout: timeoutMs,
    });
    const choice = completion.choices && completion.choices[0];
    const message = choice && choice.message;
    const content = message ? (message.content || message.reasoning_content || '') : '';
    if (!content || !content.trim()) {
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
