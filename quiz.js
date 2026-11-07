const { ask, extractJson, ERROR_MSG, MODEL_DEEPSEEK, MODEL_MIMO } = require('./llm');
const { latexToUnicode } = require('./math');
const { responseCache } = require('./cache');
const {
  getQuizPrompt,
  getExplainPrompt,
  getHintPrompt,
  QUIZ_SYSTEM_PROMPT_ID,
  EXPLAIN_SYSTEM_PROMPT_ID,
  HINT_SYSTEM_PROMPT_ID,
} = require('./i18n');

const QUIZ_SYSTEM_PROMPT = QUIZ_SYSTEM_PROMPT_ID;
const EXPLAIN_SYSTEM_PROMPT = EXPLAIN_SYSTEM_PROMPT_ID;
const HINT_SYSTEM_PROMPT = HINT_SYSTEM_PROMPT_ID;

// Truncate overly long material to stay within safe token limits
const MAX_MATERIAL_CHARS = 1500;
function truncateMaterial(text) {
  if (text.length <= MAX_MATERIAL_CHARS) return text;
  return text.slice(0, MAX_MATERIAL_CHARS) + '\n\n(...materi dipotong karena kepanjangan)';
}

function classifyComplexity(text) {
  if (!text || typeof text !== 'string') return 'light';
  const trimmed = text.trim();
  if (trimmed.length > 500) return 'heavy';

  const hasMathSymbols = /(\\[a-zA-Z]+|[∫∑∏∂√±≤≥≠≈×÷]|d\/dx|\^|_\{|\b(lim|det|matrix|sin|cos|tan)\b)/i.test(trimmed);
  if (hasMathSymbols) return 'heavy';

  const hasStemKeywords = /\b(integral|turunan|kalkulus|diferensial|matriks|vektor|trigonometri|aljabar|polinomial|eigen|termodinamika|kinematika|stokiometri|stoikiometri|algoritma|kompleksitas|pseudocode|pembuktian|olimpiade|utbk)\b/i.test(trimmed);
  if (hasStemKeywords) return 'heavy';

  const hasCode = /```|function\s+\w+|def\s+\w+|class\s+\w+/.test(trimmed);
  if (hasCode) return 'heavy';

  return 'light';
}

function validateQuiz(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const { question, options, correct_answer: correct, explanation } = obj;
  if (typeof question !== 'string' || !question.trim()) return null;
  if (!options || !['A', 'B', 'C', 'D'].includes(correct)) return null;
  if (!['A', 'B', 'C', 'D'].every((k) => typeof options[k] === 'string' && options[k].trim())) return null;
  if (typeof explanation !== 'string' || !explanation.trim()) return null;
  return {
    question: latexToUnicode(question.trim()),
    options: {
      A: latexToUnicode(options.A.trim()),
      B: latexToUnicode(options.B.trim()),
      C: latexToUnicode(options.C.trim()),
      D: latexToUnicode(options.D.trim()),
    },
    correct_answer: correct,
    explanation: latexToUnicode(explanation.trim()),
  };
}

// Generate 1 MCQ from material or image with DeepSeek primary model and retry on bad JSON
async function generateQuiz(material, imageBase64 = null, opts = {}) {
  const lang = (opts && opts.lang) || 'id';
  const cacheKey = !imageBase64 && material ? responseCache.makeKey('quiz', lang, material) : null;
  if (cacheKey) {
    const cached = responseCache.get(cacheKey);
    if (cached) return cached;
  }

  const complexity = classifyComplexity(material);
  const primaryModel = MODEL_DEEPSEEK;
  const fallbackModel = imageBase64 ? null : MODEL_MIMO;
  const timeoutMs = imageBase64 || complexity === 'heavy' ? 45000 : 30000;
  const systemPrompt = getQuizPrompt(lang);

  const isEn = lang === 'en';
  const prompt = material && material.trim()
    ? (isEn ? `Study material from user:\n\n${truncateMaterial(material)}` : `Materi belajar dari user:\n\n${truncateMaterial(material)}`)
    : (isEn ? 'Analyze the study material in the image below and create 1 multiple-choice quiz question.' : 'Analisis materi pelajaran pada gambar berikut dan buat 1 soal kuis pilihan ganda.');
  const retrySuffix = isEn
    ? '\n\n(CRITICAL: return ONLY valid JSON matching the schema, with no other text!)'
    : '\n\n(PENTING: kembalikan HANYA JSON valid sesuai schema, tanpa teks lain!)';
  let lastErr = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await ask(
        attempt === 0 ? prompt : prompt + retrySuffix,
        systemPrompt,
        {
          primaryModel,
          fallbackModel,
          maxTokens: 800,
          timeoutMs,
          imageBase64,
          temperature: 0.2,
          stop: ['}\n\n', '}\n```'],
        }
      );
      const json = extractJson(raw);
      const quiz = validateQuiz(json);
      if (quiz) {
        if (cacheKey) responseCache.set(cacheKey, quiz);
        return quiz;
      }
      lastErr = new Error('Quiz JSON tidak lolos validasi');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Gagal generate kuis');
}

function buildQuizKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'A', callback_data: 'ANS_A' },
        { text: 'B', callback_data: 'ANS_B' },
        { text: 'C', callback_data: 'ANS_C' },
        { text: 'D', callback_data: 'ANS_D' },
      ],
    ],
  };
}

function buildQuestionText(quiz, lang = 'id') {
  const isEn = lang === 'en';
  const header = isEn ? '📝 *Quiz!*' : '📝 *Kuis!*';
  const footer = isEn ? 'Select your answer below 👇' : 'Pilih jawaban lu di bawah 👇';
  return `${header}\n\n${quiz.question}\n\n` +
    `*A.* ${quiz.options.A}\n` +
    `*B.* ${quiz.options.B}\n` +
    `*C.* ${quiz.options.C}\n` +
    `*D.* ${quiz.options.D}\n\n` +
    `${footer}`;
}

module.exports = {
  generateQuiz,
  classifyComplexity,
  buildQuizKeyboard,
  buildQuestionText,
  QUIZ_SYSTEM_PROMPT,
  EXPLAIN_SYSTEM_PROMPT,
  HINT_SYSTEM_PROMPT,
  getQuizPrompt,
  getExplainPrompt,
  getHintPrompt,
  ERROR_MSG,
};
