const { ask, extractJson, MODEL_DEEPSEEK, MODEL_MIMO } = require('./llm');
const { latexToUnicode } = require('./math');
const { canTakeQuiz, recordQuizUsage, upgradeUser, getUserQuota } = require('./store');
const {
  EXPLAIN_SYSTEM_PROMPT,
  HINT_SYSTEM_PROMPT,
  ERROR_MSG,
  generateQuiz,
  classifyComplexity,
  buildQuizKeyboard,
  buildQuestionText,
} = require('./quiz');

const AI_BUSY_MSG = ERROR_MSG;

// Make LLM output Telegram-friendly: strip # headings, ---- rules, stray fences
function cleanMarkdown(text) {
  return (text || '')
    .replace(/```[a-zA-Z]*\n?/g, '')
    .split('\n')
    .filter((line) => !/^\s*-{3,}\s*$/.test(line))
    .map((line) => {
      const m = line.match(/^\s*#{1,6}\s+(.*)$/);
      return m ? `**${m[1].replace(/\s*#+\s*$/, '')}**` : line;
    })
    .join('\n')
    .trim();
}

// Per-chat quiz state: IDLE | QUIZ_ACTIVE | AWAITING_ANSWER
// Registry shape: { state, quiz, messageId }
const state = new Map();

function getState(chatId) {
  if (!state.has(chatId)) state.set(chatId, { state: 'IDLE', quiz: null, messageId: null });
  return state.get(chatId);
}

function setState(chatId, patch) {
  const s = getState(chatId);
  Object.assign(s, patch);
  return s;
}

// Ask what the user wants done with their material (per plan: ask each time)
const CHOICE_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '📚 Bikin Kuis', callback_data: 'CHOICE_QUIZ' },
      { text: '🧠 Jelasin Materi', callback_data: 'CHOICE_EXPLAIN' },
    ],
  ],
};

// Send message with Unicode-converted math; try Markdown, else plain text
async function sendSmart(bot, chatId, text, opts = {}) {
  const raw = typeof text === 'string' ? text : String(text || '');
  const clean = raw.trim();
  const safe = latexToUnicode(clean || ERROR_MSG);
  try {
    return await bot.sendMessage(chatId, safe, { ...opts, parse_mode: 'Markdown' });
  } catch (e) {
    if (e.response && e.response.body && e.response.body.description &&
        /parse/i.test(e.response.body.description)) {
      return await bot.sendMessage(chatId, safe.replace(/[*_`]/g, ''), opts);
    }
    throw e;
  }
}

// Download Telegram photo or document file and convert to Base64 data URL
async function downloadTelegramImageAsBase64(bot, fileId, defaultMime = 'image/jpeg') {
  const fileLink = await bot.getFileLink(fileId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(fileLink, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Failed to download Telegram file (${res.status})`);
    }
    const contentType = res.headers.get('content-type') || defaultMime;
    const arrayBuffer = await res.arrayBuffer();
    const base64Data = Buffer.from(arrayBuffer).toString('base64');
    return `data:${contentType};base64,${base64Data}`;
  } finally {
    clearTimeout(timer);
  }
}

function register(bot) {
  const BOT_COMMANDS = [
    { command: 'start', description: 'Mulai bot & panduan belajar' },
    { command: 'ceklimit', description: 'Cek sisa limit kuis harian' },
    { command: 'iduser', description: 'Lihat ID Telegram untuk upgrade' },
  ];
  if (typeof bot.setMyCommands === 'function') {
    bot.setMyCommands(BOT_COMMANDS).catch((err) => {
      console.error('Failed to set Telegram commands menu:', err.message);
    });
  }

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    setState(chatId, { state: 'IDLE', quiz: null, messageId: null, imageBase64: null });
    bot.sendMessage(
      chatId,
      'Hai! 👋 Gw *GampangBot*, asisten belajar kompetitiflu.\n\n' +
        'Kirim aja materi belajar, catatan, gambar/foto materi, atau syllabus ke sini.\n' +
        'Nanti gw bisa:\n' +
        '📚 Bikinin kuis pilihan ganda\n' +
        '🧠 Jelasin materi pake gaya anak SD (santai & gampang)\n\n' +
        'Gaskeun, kirim materinya! 🚀',
      { parse_mode: 'Markdown' }
    );
  });

  bot.onText(/\/ceklimit/, async (msg) => {
    const userId = msg.from ? msg.from.id : msg.chat.id;
    const quota = getUserQuota(userId);

    if (quota.isPremium) {
      const expiryDate = new Date(quota.premiumUntil).toLocaleString('id-ID', {
        timeZone: 'Asia/Jakarta',
      });
      await sendSmart(
        bot,
        msg.chat.id,
        `📊 *Status Limit Kamu*\n\n` +
        `Status: ⭐ Premium (Unlimited Kuis)\n` +
        `Aktif sampai: ${expiryDate} WIB\n\n` +
        `Gaskeun latihan sepuasnya tanpa batas harian! 🚀`
      );
      return;
    }

    if (quota.remaining === 0) {
      await sendSmart(
        bot,
        msg.chat.id,
        `📊 *Status Limit Kamu*\n\n` +
        `Status: Free\n` +
        `Sisa Kuis Hari Ini: 0/${quota.total} (Habis)\n` +
        `Reset setiap 00:00 WIB\n\n` +
        `Limit Quiz kamu sudah habis! Mau upgrade limit untuk persiapan ujian besok? Cuma 10.000 buat 7 Hari, Chat owner @satirvx`
      );
      return;
    }

    await sendSmart(
      bot,
      msg.chat.id,
      `📊 *Status Limit Kamu*\n\n` +
      `Status: Free\n` +
      `Sisa Kuis Hari Ini: ${quota.remaining}/${quota.total}\n` +
      `Reset setiap 00:00 WIB\n\n` +
      `Kirim catatan atau materi kamu ke sini buat mulai kuis! 🚀`
    );
  });

  bot.onText(/\/iduser/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      `ID Telegram kamu: \`${msg.from.id}\`\nKirim ID ini ke owner @satirvx buat upgrade kuis.`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.onText(/\/upgrade(?:\s+(.+))?/, async (msg, match) => {
    const adminId = process.env.ADMIN_ID;
    if (!adminId || String(msg.from.id) !== String(adminId)) {
      bot.sendMessage(msg.chat.id, 'Akses ditolak. Perintah ini cuma buat admin.');
      return;
    }

    const rawArgs = (match && match[1] ? match[1].trim() : '').split(/\s+/);
    const targetUserId = rawArgs[0];
    const days = parseInt(rawArgs[1], 10);

    if (!targetUserId || isNaN(days) || days <= 0) {
      bot.sendMessage(
        msg.chat.id,
        'Format salah! Gunakan: `/upgrade <userId> <days>`\nContoh: `/upgrade 123456789 7`',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const user = upgradeUser(targetUserId, days);
    const expiryDate = new Date(user.premiumUntil).toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
    });

    await bot.sendMessage(
      msg.chat.id,
      `✅ Berhasil upgrade user \`${targetUserId}\` selama ${days} hari.\nKadaluarsa: ${expiryDate} WIB`,
      { parse_mode: 'Markdown' }
    );

    try {
      await bot.sendMessage(
        targetUserId,
        `🎉 Akun kamu sudah di-upgrade ke Premium selama ${days} hari! Sekarang kamu bisa bikin kuis tanpa batas harian. Makasih udah support @satirvx! 🚀`
      );
    } catch (err) {
      bot.sendMessage(msg.chat.id, `⚠️ Gagal kirim notifikasi ke user: ${err.message}`);
    }
  });

  bot.on('message', async (msg) => {
    if (msg.text && msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const s = getState(chatId);

    const isPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
    const isImageDoc =
      msg.document &&
      typeof msg.document.mime_type === 'string' &&
      msg.document.mime_type.startsWith('image/');
    const isImage = isPhoto || isImageDoc;

    if (!msg.text && !isImage) return;

    // Check if an AI action is already actively computing for this user
    if (s.state === 'QUIZ_ACTIVE' || s.state === 'EXPLAIN_ACTIVE') {
      bot.sendMessage(chatId, 'Sabar ya, lagi diproses nih... ⏳');
      return;
    }

    // Quiz is locked while waiting for an answer: never change the question
    if (s.state === 'AWAITING_ANSWER' && s.quiz) {
      if (isImage) {
        bot.sendMessage(chatId, 'Nope, soalnya udah dikunci 🔒 Selesaikan dulu kuis yang lagi aktif ya!');
        return;
      }
      handleHint(chatId, msg.text);
      return;
    }

    if (isImage) {
      try {
        const fileId = isPhoto ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
        const mimeType = isImageDoc ? msg.document.mime_type : 'image/jpeg';
        const imageBase64 = await downloadTelegramImageAsBase64(bot, fileId, mimeType);
        const caption = typeof msg.caption === 'string' ? msg.caption.trim() : '';

        setState(chatId, {
          state: 'IDLE',
          quiz: null,
          messageId: null,
          material: caption,
          imageBase64,
        });

        bot.sendMessage(
          chatId,
          'Oke, dapet gambarnya! 📸\nMau gw apain nih?',
          { reply_markup: CHOICE_KEYBOARD }
        );
      } catch (err) {
        console.error('Failed to process incoming image:', err.message);
        bot.sendMessage(chatId, 'Waduh, gagal download gambarnya. Boleh coba kirim ulang? 🙏');
      }
      return;
    }

    // Regular text material
    setState(chatId, {
      state: 'IDLE',
      quiz: null,
      messageId: null,
      material: msg.text,
      imageBase64: null,
    });

    bot.sendMessage(
      chatId,
      'Oke, dapet materinya! 📥\nMau gw apain nih?',
      { reply_markup: CHOICE_KEYBOARD }
    );
  });

  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const s = getState(chatId);

    try {
      // Choice: quiz vs explain
      if (data === 'CHOICE_QUIZ' || data === 'CHOICE_EXPLAIN') {
        if (s.state === 'QUIZ_ACTIVE' || s.state === 'EXPLAIN_ACTIVE') {
          await bot.answerCallbackQuery(query.id, { text: 'Sabar ya, lagi diproses nih... ⏳' });
          return;
        }

        if (data === 'CHOICE_QUIZ' && !canTakeQuiz(chatId)) {
          await bot.answerCallbackQuery(query.id);
          await bot.editMessageReplyMarkup(undefined, {
            chat_id: chatId,
            message_id: query.message.message_id,
          }).catch(() => {});
          bot.sendMessage(
            chatId,
            'Limit Quiz kamu sudah habis! Mau upgrade limit untuk persiapan ujian besok? Cuma 10.000 buat 7 Hari, Chat owner @satirvx'
          );
          return;
        }

        await bot.answerCallbackQuery(query.id);
        const material = s.material;
        const imageBase64 = s.imageBase64;
        if (!material && !imageBase64) {
          bot.sendMessage(chatId, 'Materinya belum ada nih, kirim dulu dong 🙏');
          return;
        }
        // Acknowledge & clear old keyboard
        await bot.editMessageReplyMarkup(undefined, {
          chat_id: chatId,
          message_id: query.message.message_id,
        }).catch(() => {});

        setState(chatId, { choice: data });

        // Show typing while the AI works
        const typing = setInterval(() => {
          bot.sendChatAction(chatId, 'typing').catch(() => {});
        }, 4000);
        const stopTyping = () => clearInterval(typing);

        if (data === 'CHOICE_QUIZ') {
          handleQuiz(chatId).finally(stopTyping);
        } else {
          handleExplain(chatId, material, imageBase64).finally(stopTyping);
        }
        return;
      }

      // Answer click: A/B/C/D
      if (data.startsWith('ANS_')) {
        const answer = data.slice(4); // 'A'..'D'
        await bot.answerCallbackQuery(query.id);

        if (s.state !== 'AWAITING_ANSWER' || !s.quiz) {
          // Late or duplicate click: quiz already answered
          bot.sendMessage(chatId, 'Kuisnya udah kejawab tuh, kirim materi baru yuk! 🔁');
          return;
        }

        const quiz = s.quiz;
        const isCorrect = answer === quiz.correct_answer;

        // Mark quiz as answered (block double clicks)
        setState(chatId, { state: 'QUIZ_DONE' });

        const emoji = isCorrect ? '✅' : '❌';
        const verdict = isCorrect ? 'BENAR!' : 'KURANG TEPAT!';
        const header = `${emoji} *${verdict}*`;
        const correctNote = isCorrect
          ? ''
          : `\n\nJawaban yang bener: *${quiz.correct_answer}. ${quiz.options[quiz.correct_answer]}*`;

        try {
          await bot.editMessageReplyMarkup(undefined, {
            chat_id: chatId,
            message_id: query.message.message_id,
          });
        } catch (e) { /* best effort */ }

        await sendSmart(
          bot,
          chatId,
          `${header}\nJawaban lu: *${answer}. ${quiz.options[answer]}*${correctNote}\n\n` +
            `💡 _${quiz.explanation}_\n\n` +
            `Mau lanjut? Kirim materi lain dong! 📥`
        );
        return;
      }
    } catch (e) {
      console.error('callback_query handler error:', e);
      try { await bot.answerCallbackQuery(query.id, { text: 'Waduh, error. Coba lagi ya 😅' }); } catch (_) {}
      bot.sendMessage(chatId, AI_BUSY_MSG).catch(() => {});
    }
  });

  // Refuse quiz changes and provide a clue without leaking the answer
  async function handleHint(chatId, userMessage) {
    const s = getState(chatId);
    const quiz = s.quiz;
    const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000);

    try {
      const optionsText = Object.entries(quiz.options)
        .map(([k, v]) => `${k}. ${v}`)
        .join('\n');
      const MAX_CHARS = 2000;
      const material = (s.material || '').slice(0, MAX_CHARS);
      const prompt =
        `Materi:\n${material}\n\n` +
        `Pertanyaan kuis yang DIKUNCI (JANGAN diubah):\n${quiz.question}\n\nPilihan:\n${optionsText}\n\n` +
        `Pesan user: "${userMessage}"`;
      const reply = await ask(prompt, HINT_SYSTEM_PROMPT, {
        primaryModel: MODEL_DEEPSEEK,
        fallbackModel: MODEL_MIMO,
        maxTokens: 250,
        timeoutMs: 30000,
      });
      await sendSmart(bot, chatId, cleanMarkdown(reply));
    } catch (e) {
      console.error('Hint error:', e);
      await sendSmart(bot, chatId, 'Nope, soalnya udah dikunci 🔒 Fokus jawab yang ada ya, lu pasti bisa! 💪');
    } finally {
      clearInterval(typing);
    }
  }

  async function handleQuiz(chatId) {
    const s = getState(chatId);
    setState(chatId, { state: 'QUIZ_ACTIVE' });
    bot.sendMessage(chatId, 'Oke, lagi gw bikinin soal nih... ⏳');

    try {
      const quiz = await generateQuiz(s.material, s.imageBase64);
      const sent = await sendSmart(bot, chatId, buildQuestionText(quiz), {
        reply_markup: buildQuizKeyboard(),
      });
      recordQuizUsage(chatId);
      setState(chatId, {
        state: 'AWAITING_ANSWER',
        quiz,
        messageId: sent.message_id,
        imageBase64: null,
      });
    } catch (e) {
      console.error('Quiz generation error:', e);
      setState(chatId, { state: 'IDLE', quiz: null, imageBase64: null });
      bot.sendMessage(chatId, AI_BUSY_MSG).catch(() => {});
    }
  }

  async function handleExplain(chatId, material, imageBase64 = null) {
    setState(chatId, { state: 'EXPLAIN_ACTIVE' });
    bot.sendMessage(chatId, 'Oke, lagi gw jelasin materinya nih... ⏳');

    try {
      const MAX_CHARS = 3000;
      const trimmed = (material || '').slice(0, MAX_CHARS);
      const complexity = classifyComplexity(trimmed);
      const isHeavy = Boolean(imageBase64) || complexity === 'heavy';
      const primaryModel = MODEL_DEEPSEEK;
      const fallbackModel = imageBase64 ? null : MODEL_MIMO;
      const maxTokens = isHeavy ? 1000 : 750;
      const timeoutMs = isHeavy ? 60000 : 45000;

      const prompt = imageBase64 && (!trimmed || !trimmed.trim())
        ? 'Jelaskan materi yang ada pada gambar berikut secara bertahap dan mudah dipahami.'
        : `Materi dari user:\n\n${trimmed}`;

      const explanation = await ask(
        prompt,
        EXPLAIN_SYSTEM_PROMPT,
        { primaryModel, fallbackModel, maxTokens, timeoutMs, imageBase64 }
      );
      await sendSmart(bot, chatId, cleanMarkdown(explanation));
      setState(chatId, { state: 'IDLE', imageBase64: null });
    } catch (e) {
      console.error('Explain error:', e);
      setState(chatId, { state: 'IDLE', imageBase64: null });
      bot.sendMessage(chatId, AI_BUSY_MSG).catch(() => {});
    }
  }
}

module.exports = {
  register,
  getState,
  setState,
  downloadTelegramImageAsBase64,
  sendSmart,
};
