// i18n.js - Multi-language dictionaries and prompt factories for GampangBot

const DEFAULT_LANGUAGE = 'en';
const SUPPORTED_LANGUAGES = ['en', 'id'];

const STRINGS = {
  en: {
    start:
      'Hi! I am GampangBot, your AI exam study partner 🎓\n\n' +
      'Send me your study material (text or photo/image document), then choose:\n' +
      '• *Quiz*: Test your concept mastery with 1 multiple-choice question.\n' +
      '• *Explain*: Get a concise summary of the core concepts.\n\n' +
      'Helpful commands:\n' +
      '/quiz [material] - Generate a multiple-choice quiz directly\n' +
      '/reset - Clear conversation memory & previous material\n' +
      '/language - Change bot language\n' +
      '/ceklimit - Check your daily quota status\n' +
      '/iduser - View your Telegram ID for premium upgrade',
    received_material: 'Got your material! 📥\nWhat would you like me to do?',
    received_image: 'Got your image! 📸\nWhat would you like me to do?',
    processing: 'Hold on, processing... ⏳',
    generating_quiz: 'Creating your quiz question... ⏳',
    explaining: 'Explaining your material... ⏳',
    quiz_locked: 'Nope, the question is locked 🔒 Please finish your active quiz first!',
    quiz_done_late: 'That quiz was already answered. Send new material to start again! 🔁',
    material_missing: 'No material found yet. Please send some material first! 🙏',
    image_download_failed: 'Oops, failed to download the image. Could you please send it again? 🙏',
    reset_done: 'Memory cleared! 🧹\nSend new study material anytime.',
    quota_quiz_exhausted:
      "Your Quiz limit is reached! Want to upgrade your limit for tomorrow's exam preparation? Only 10,000 for 7 Days, contact owner @satirvx",
    quota_explain_exhausted:
      "Your Explanation limit is reached! Want to upgrade your limit for tomorrow's exam preparation? Only 10,000 for 7 Days, contact owner @satirvx",
    quota_image_exhausted:
      "Your Image upload limit is reached! Want to upgrade your limit for tomorrow's exam preparation? Only 10,000 for 7 Days, contact owner @satirvx",
    ai_busy: 'AI server is currently busy. Please try resending your material shortly.',
    iduser_msg:
      'Your Telegram ID is:\n`{userId}`\n\nSend this ID to owner @satirvx to upgrade your account to Premium ⭐',
    language_select: '🌐 Choose your preferred language / Pilih bahasa yang kamu inginkan:',
    language_set: '✅ Language updated to English!',
    language_btn_en: '🇬🇧 English',
    language_btn_id: '🇮🇩 Bahasa Indonesia',
    quiz_header: '📝 *Quiz!*',
    quiz_footer: 'Select your answer below 👇',
    quiz_correct: 'CORRECT!',
    quiz_incorrect: 'NOT QUITE!',
    quiz_your_answer: 'Your answer: *{letter}. {text}*',
    quiz_correct_answer: '\n\nCorrect answer: *{letter}. {text}*',
    quiz_next_prompt: 'Want to continue? Send more material! 📥',
    btn_quiz: '📝 Create Quiz',
    btn_explain: '💡 Explain Concept',
    hint_refusal: 'Nope, the question is locked 🔒 Focus on answering what is on screen, you got this! 💪',
    hint_limit_reached: 'Hint limit reached (max 2 per quiz) 🔒 Please choose your answer from the buttons below! 👇',
    ceklimit_title: '📊 *Your Daily Quota Status*',
    ceklimit_quiz: '• Quiz: *{used}*',
    ceklimit_explain: '• Explanation: *{used}*',
    ceklimit_image: '• Image Upload: *{used}*',
    ceklimit_reset: 'Resets daily at 00:00 WIB',
    ceklimit_status_free: 'Status: Free',
    ceklimit_status_premium: 'Status: ⭐ Premium (Unlimited Quiz, Explanations, & Images)',
    ceklimit_expires: 'Active until: {date}',
    ceklimit_exhausted_suffix: ' (Exhausted)',
    empty_quiz_prompt:
      'Send your study material first (e.g. `/quiz Newton\'s Laws`) or send notes/images so I can make a quiz! 🙏',
  },
  id: {
    start:
      'Halo! Gua GampangBot, asisten belajar ujian lu 🎓\n\n' +
      'Kirim materi lu (bisa teks atau foto/dokumen gambar materi), terus pilih:\n' +
      '• *Kuis*: Uji pemahaman konsep lu lewat 1 soal pilihan ganda.\n' +
      '• *Jelasin*: Rangkum dan pahami konsep intinya secara padat.\n\n' +
      'Perintah bantuan:\n' +
      '/quiz [materi] - Langsung bikin kuis pilihan ganda dari materi\n' +
      '/reset - Hapus ingatan materi & percakapan sebelumnya\n' +
      '/language - Ganti bahasa bot\n' +
      '/ceklimit - Cek sisa kuota harian kamu\n' +
      '/iduser - Lihat ID Telegram untuk upgrade premium',
    received_material: 'Oke, dapet materinya! 📥\nMau gw apain nih?',
    received_image: 'Oke, dapet gambarnya! 📸\nMau gw apain nih?',
    processing: 'Sabar ya, lagi diproses nih... ⏳',
    generating_quiz: 'Oke, lagi gw bikinin soal nih... ⏳',
    explaining: 'Oke, lagi gw jelasin materinya nih... ⏳',
    quiz_locked: 'Nope, soalnya udah dikunci 🔒 Selesaikan dulu kuis yang lagi aktif ya!',
    quiz_done_late: 'Kuisnya udah kejawab tuh, kirim materi baru yuk! 🔁',
    material_missing: 'Materinya belum ada nih, kirim dulu dong 🙏',
    image_download_failed: 'Waduh, gagal download gambarnya. Boleh coba kirim ulang? 🙏',
    reset_done: 'Sip, ingatan materi & percakapan sebelumnya udah di-reset! 🧹\nKirim materi baru yuk.',
    quota_quiz_exhausted:
      'Limit Quiz kamu sudah habis! Mau upgrade limit untuk persiapan ujian besok? Cuma 10.000 buat 7 Hari, Chat owner @satirvx',
    quota_explain_exhausted:
      'Limit Penjelasan kamu sudah habis! Mau upgrade limit untuk persiapan ujian besok? Cuma 10.000 buat 7 Hari, Chat owner @satirvx',
    quota_image_exhausted:
      'Limit upload Gambar kamu sudah habis! Mau upgrade limit untuk persiapan ujian besok? Cuma 10.000 buat 7 Hari, Chat owner @satirvx',
    ai_busy: 'Server AI lagi sibuk nih, coba kirim ulang materi lu bentar lagi ya.',
    iduser_msg:
      'ID Telegram kamu adalah:\n`{userId}`\n\nKirimkan ID ini ke owner @satirvx untuk proses upgrade akun ke Premium ⭐',
    language_select: '🌐 Pilih bahasa yang kamu inginkan / Choose your preferred language:',
    language_set: '✅ Bahasa bot diatur ke Bahasa Indonesia!',
    language_btn_en: '🇬🇧 English',
    language_btn_id: '🇮🇩 Bahasa Indonesia',
    quiz_header: '📝 *Kuis!*',
    quiz_footer: 'Pilih jawaban lu di bawah 👇',
    quiz_correct: 'BENAR!',
    quiz_incorrect: 'KURANG TEPAT!',
    quiz_your_answer: 'Jawaban lu: *{letter}. {text}*',
    quiz_correct_answer: '\n\nJawaban yang bener: *{letter}. {text}*',
    quiz_next_prompt: 'Mau lanjut? Kirim materi lain dong! 📥',
    btn_quiz: '📝 Bikin Kuis',
    btn_explain: '💡 Jelasin Konsep',
    hint_refusal: 'Nope, soalnya udah dikunci 🔒 Fokus jawab yang ada ya, lu pasti bisa! 💪',
    hint_limit_reached: 'Batas petunjuk tercapai (maks 2 per kuis) 🔒 Yuk langsung pilih jawaban di tombol bawah! 👇',
    ceklimit_title: '📊 *Status Kuota Harian Kamu*',
    ceklimit_quiz: '• Kuis: *{used}*',
    ceklimit_explain: '• Penjelasan: *{used}*',
    ceklimit_image: '• Upload Gambar: *{used}*',
    ceklimit_reset: 'Reset setiap 00:00 WIB',
    ceklimit_status_free: 'Status: Free',
    ceklimit_status_premium: 'Status: ⭐ Premium (Unlimited Kuis, Penjelasan, & Gambar)',
    ceklimit_expires: 'Aktif sampai: {date}',
    ceklimit_exhausted_suffix: ' (Habis)',
    empty_quiz_prompt:
      'Kirim dulu materinya dong (contoh: `/quiz Hukum Newton`) atau kirim catatan/gambar materi biar bisa gw bikinin kuis! 🙏',
  },
};

function normalizeLang(lang) {
  if (!lang) return DEFAULT_LANGUAGE;
  const l = String(lang).trim().toLowerCase();
  return l === 'id' ? 'id' : 'en';
}

function t(lang, key, params = {}) {
  const selectedLang = normalizeLang(lang);
  const dict = STRINGS[selectedLang] || STRINGS.en;
  let text = dict[key] || STRINGS.en[key] || key;

  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return text;
}

const QUIZ_SYSTEM_PROMPT_EN = `You are GampangBot, an expert conceptual tutor and objective exam quiz generator for students.
Task: Create EXACTLY 1 multiple-choice question based on the study material provided by the user.

CRITICAL CONSTRAINTS:
1. You MUST return ONLY valid raw JSON without markdown code blocks or backticks. Output must start immediately with '{' and end with '}'.
2. Required JSON Schema:
{
  "question": "Question testing concept comprehension",
  "options": {
    "A": "Option A text",
    "B": "Option B text",
    "C": "Option C text",
    "D": "Option D text"
  },
  "correct_answer": "A",
  "explanation": "Solid, substantive conceptual explanation (1-2 sentences) of why this answer is correct."
}
3. Difficulty: Medium (focus on understanding concepts, not rote memorization).
4. Output Language: MUST be in clear, natural English, regardless of the input language.
5. Math formatting: write math in simple Unicode that works everywhere (example: x², √2, 3/4, π, ≤, ×). Do NOT use LaTeX commands like \\frac{}, \\sqrt{}, ^{}, $...$.
6. Paragraphs and explanations must be solid, substantive, and conceptually deep, not too light or superficial.
7. CRITICAL: Your ONLY job is to create ONE quiz question from the material. NEVER solve, derive, calculate, or explain the material's math. NEVER show working steps or derivations. In the explanation, state the conceptual principle directly without arithmetic derivations.
8. Do not include verbose introductory greetings, conversational filler, or preamble. Output must start directly with '{' and end with '}'.`;

const QUIZ_SYSTEM_PROMPT_ID = `You are GampangBot, an expert conceptual tutor and objective exam quiz generator for Indonesian high school/university students.
Task: Create EXACTLY 1 multiple-choice question based on the study material provided by the user.

CRITICAL CONSTRAINTS:
1. You MUST return ONLY valid raw JSON without markdown code blocks or backticks. Output must start immediately with '{' and end with '}'.
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
  "explanation": "Penjelasan konsep inti yang padat dan berbobot (solid, not too light) 1-2 kalimat kenapa jawaban tersebut benar."
}
3. Difficulty: Medium (focus on understanding concepts, not rote memorization).
4. Output Language: MUST be in casual, clear Indonesian (Bahasa Indonesia santai, analogi praktis, mudah dipahami), regardless of the input language.
5. Math formatting: write math in simple Unicode that works everywhere (contoh: x², √2, 3/4, π, ≤, ×). Do NOT use LaTeX commands like \\frac{}, \\sqrt{}, ^{}, $...$.
6. Paragraphs and explanations must be solid, substantive, and conceptually deep, not too light or superficial.
7. CRITICAL: Your ONLY job is to create ONE quiz question from the material. NEVER solve, derive, calculate, or explain the material's math. NEVER show working steps or derivations. In the explanation, state the conceptual principle directly without arithmetic derivations.
8. Do not include verbose introductory greetings, conversational filler, or preamble. Output must start directly with '{' and end with '}'.`;

const EXPLAIN_SYSTEM_PROMPT_EN = `You are GampangBot, an expert conceptual tutor for students.
Task: Explain the core concepts from the input material clearly and concisely.

CRITICAL CONSTRAINTS:
1. Max length: Under 300 words total. Do NOT exceed this limit.
2. Structure your output strictly into 3 bullet points:
   - 🎯 Core Concept (1-2 sentences)
   - ⚙️ Key Formula / How It Works (bullet points, max 4 lines)
   - 💡 Exam Traps / Quick Tips (1-2 sentences)
3. Do not include verbose introductory greetings or conversational filler.
4. Language: English (clear, engaging, practical analogies, easy to understand).
5. Output must be solid, substantive, and conceptually deep, not too light or superficial (concise, high-density, to-the-point).
6. Math formatting: write math in simple Unicode that works everywhere (example: x², √2, 3/4, π, ≤, ×). Do NOT use LaTeX commands like \\frac{}, \\sqrt{}, ^{}, $...$.`;

const EXPLAIN_SYSTEM_PROMPT_ID = `You are GampangBot, an expert conceptual tutor for Indonesian high school/university students.
Task: Explain the core concepts from the input material clearly and concisely.

CRITICAL CONSTRAINTS:
1. Max length: Under 300 words total. Do NOT exceed this limit.
2. Structure your output strictly into 3 bullet points:
   - 🎯 Konsep Inti (1-2 sentences)
   - ⚙️ Cara Kerja / Rumus Kunci (bullet points, max 4 lines)
   - 💡 Jebakan Ujian / Tips Cepat (1-2 sentences)
3. Do not include verbose introductory greetings or conversational filler.
4. Language: Indonesian (gaya santai, analogi praktis, mudah dipahami).
5. Output must be solid, substantive, and conceptually deep, not too light or superficial (penjelasan padat berbobot, to-the-point).
6. Math formatting: write math in simple Unicode that works everywhere (contoh: x², √2, 3/4, π, ≤, ×). Do NOT use LaTeX commands like \\frac{}, \\sqrt{}, ^{}, $...$.`;

const HINT_SYSTEM_PROMPT_EN = `You are GampangBot, a firm but supportive quiz proctor for students.
Context: The user is currently answering a locked multiple-choice quiz. The user sent a message that might be asking to CHANGE the question, or trying to fish for the answer.

Task:
1. Politely but firmly REFUSE to change, replace, or regenerate the question. The quiz is locked.
2. Then give the user ONE helpful clue (hint) about the CURRENT question that nudges their thinking in the right direction.

Strict Rules:
- Output MUST be in natural, friendly English.
- Start your first sentence with "Nope, the question is locked 🔒" or a similar firm friendly refusal.
- NEVER reveal the correct answer, its letter (A/B/C/D), or its exact text.
- Do NOT say which options are wrong/correct. No elimination hints.
- Keep it short: 1 refusal sentence + max 2 sentences of clue.
- Math formatting: write math in simple Unicode (x², √2, π, ≤, ×). Do NOT use LaTeX commands.
- Format: plain text only, max 3 sentences total.`;

const HINT_SYSTEM_PROMPT_ID = `You are GampangBot, a firm but supportive quiz proctor for students.
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

function getQuizPrompt(lang) {
  return normalizeLang(lang) === 'id' ? QUIZ_SYSTEM_PROMPT_ID : QUIZ_SYSTEM_PROMPT_EN;
}

function getExplainPrompt(lang) {
  return normalizeLang(lang) === 'id' ? EXPLAIN_SYSTEM_PROMPT_ID : EXPLAIN_SYSTEM_PROMPT_EN;
}

function getHintPrompt(lang) {
  return normalizeLang(lang) === 'id' ? HINT_SYSTEM_PROMPT_ID : HINT_SYSTEM_PROMPT_EN;
}

module.exports = {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  normalizeLang,
  t,
  getQuizPrompt,
  getExplainPrompt,
  getHintPrompt,
  QUIZ_SYSTEM_PROMPT_EN,
  QUIZ_SYSTEM_PROMPT_ID,
  EXPLAIN_SYSTEM_PROMPT_EN,
  EXPLAIN_SYSTEM_PROMPT_ID,
  HINT_SYSTEM_PROMPT_EN,
  HINT_SYSTEM_PROMPT_ID,
};
