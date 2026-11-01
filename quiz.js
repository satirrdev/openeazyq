const { ask, extractJson, ERROR_MSG, MODEL_DEEPSEEK, MODEL_MIMO } = require('./llm');
const { latexToUnicode } = require('./math');

const QUIZ_SYSTEM_PROMPT = `You are GampangBot, an objective and concise exam quiz generator for students.
Task: Create EXACTLY 1 multiple-choice question based on the study material provided by the user.

Strict Output Rules:
1. You MUST return ONLY valid raw JSON without markdown code blocks or backticks. Output must start immediately with '{'.
2. Required JSON Schema:
{
  "question": "Pertanyaan yang menguji pemahaman konsep",
  "options": {
    "A": "Teks pilihan A",
    "B": "Teks pilihan B",
    "C": "Teks pilihan C",
    "D": "Teks pilihan D"
  },
  "correct_answer": "A",
  "explanation": "Penjelasan singkat 1-2 kalimat kenapa jawaban tersebut benar."
}
3. Difficulty: Medium (focus on understanding concepts, not rote memorization).
4. Output Language: MUST be in casual, clear Indonesian (Bahasa Indonesia santai tapi jelas), regardless of the input language.
5. Math formatting: write math in simple Unicode that works everywhere (contoh: x², √2, 3/4, π, ≤, ×). Do NOT use LaTeX commands like \\frac{}, \\sqrt{}, ^{}, $...$.
6. CRITICAL: Your ONLY job is to create ONE quiz question from the material. NEVER solve, derive, calculate, or explain the material's math. NEVER show working steps or derivations. In the explanation, state the conceptual principle directly without arithmetic derivations.
7. Output must start directly with '{' and end with '}'. No preamble, no working scratchpad, no markdown code fences.`;

const EXPLAIN_SYSTEM_PROMPT = `You are GampangBot, a direct and helpful study assistant.
Task: Explain the material that the user is learning, using the "Explain Like I'm 5" skill.
Rules:
- All output MUST be in casual Indonesian (Bahasa Indonesia).
- First: Start with a step-by-step explanation, slowly and clearly.
- Second: Then, explain the Main or the Core, with detail, but still clearly so the user gets it.
- Last: Write a summary of what you explained before.
- Math formatting: write math in simple Unicode that works everywhere (contoh: x², √2, 3/4, π, ≤, ×). Do NOT use LaTeX commands like \\frac{}, \\sqrt{}, ^{}, $...$.`;

const HINT_SYSTEM_PROMPT = `You are GampangBot, a firm but supportive quiz proctor for students.
Context: The user is currently answering a locked multiple-choice quiz. The user sent a message that might be asking to CHANGE the question, or trying to fish for the answer.

Task:
1. Politely but firmly REFUSE to change, replace, or regenerate the question. The quiz is locked.
2. Then give the user ONE helpful clue (petunjuk) about the CURRENT question that nudges their thinking in the right direction.

Strict Rules:
- Output MUST be in casual Indonesian (Bahasa Indonesia santai tapi jelas).
- Start your first sentence with "Nope, soalnya udah dikunci 🔒" or a similar firm casual refusal.
- NEVER reveal the correct answer, its letter (A/B/C/D), or its exact text.
- Do NOT say which options are wrong/correct. No elimination hints.
- Keep it short: 1 refusal sentence + max 2 sentences of clue.
- Math formatting: write math in simple Unicode (x², √2, π, ≤, ×). Do NOT use LaTeX commands.
- Format: plain text only, max 3 sentences total.`;

// Truncate overly long material to stay within safe token limits
const MAX_MATERIAL_CHARS = 3000;
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
async function generateQuiz(material, imageBase64 = null) {
  const complexity = classifyComplexity(material);
  const primaryModel = MODEL_DEEPSEEK;
  const fallbackModel = imageBase64 ? null : MODEL_MIMO;
  const timeoutMs = imageBase64 || complexity === 'heavy' ? 45000 : 30000;

  const prompt = material && material.trim()
    ? `Materi belajar dari user:\n\n${truncateMaterial(material)}`
    : 'Analisis materi pelajaran pada gambar berikut dan buat 1 soal kuis pilihan ganda.';
  let lastErr = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await ask(
        attempt === 0 ? prompt : prompt + '\n\n(PENTING: kembalikan HANYA JSON valid sesuai schema, tanpa teks lain!)',
        QUIZ_SYSTEM_PROMPT,
        {
          primaryModel,
          fallbackModel,
          maxTokens: 800,
          timeoutMs,
          imageBase64,
        }
      );
      const json = extractJson(raw);
      const quiz = validateQuiz(json);
      if (quiz) return quiz;
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

function buildQuestionText(quiz) {
  return `📝 *Kuis!*\n\n${quiz.question}\n\n` +
    `*A.* ${quiz.options.A}\n` +
    `*B.* ${quiz.options.B}\n` +
    `*C.* ${quiz.options.C}\n` +
    `*D.* ${quiz.options.D}\n\n` +
    `Pilih jawaban lu di bawah 👇`;
}

module.exports = {
  generateQuiz,
  classifyComplexity,
  buildQuizKeyboard,
  buildQuestionText,
  EXPLAIN_SYSTEM_PROMPT,
  HINT_SYSTEM_PROMPT,
  ERROR_MSG,
};
