const { ask, extractJson, MODEL_DEEPSEEK, MODEL_MIMO } = require('./llm');
const { latexToUnicode } = require('./math');
const {
  canTakeQuiz,
  canExplain,
  canUploadImage,
  recordQuizUsage,
  recordExplainUsage,
  recordImageUsage,
  upgradeUser,
  getUserQuota,
  DAILY_EXPLAIN_LIMIT,
  DAILY_IMAGE_LIMIT,
} = require('./store');
const {
  EXPLAIN_SYSTEM_PROMPT,
  HINT_SYSTEM_PROMPT,
  ERROR_MSG,
  generateQuiz,
  classifyComplexity,
  buildQuizKeyboard,
  buildQuestionText,
} = require('./quiz');
const { performBackup } = require('./backup');

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
// Registry shape: { state, quiz, messageId, history, lastActivity }
const state = new Map();
const IDLE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getState(chatId) {
  const now = Date.now();
  if (state.has(chatId)) {
    const existing = state.get(chatId);
    if (existing && existing.lastActivity && now - existing.lastActivity > IDLE_TTL_MS) {
      // User idle for > 30 minutes: purge session data
      state.delete(chatId);
    }
  }
  if (!state.has(chatId)) {
    state.set(chatId, {
      state: 'IDLE',
      quiz: null,
      messageId: null,
      history: [],
      lastActivity: now,
    });
  }
  const s = state.get(chatId);
  if (!Array.isArray(s.history)) {
    s.history = [];
  }
  s.lastActivity = now;
  return s;
}

function setState(chatId, patch) {
  const s = getState(chatId);
  Object.assign(s, patch, { lastActivity: Date.now() });
  return s;
}

function cleanupIdleUsers(ttlMs = IDLE_TTL_MS) {
  const now = Date.now();
  let purged = 0;
  for (const [chatId, s] of state.entries()) {
    if (s && s.lastActivity && now - s.lastActivity > ttlMs) {
      state.delete(chatId);
      purged++;
    }
  }
  return purged;
}

const idleSweepInterval = setInterval(() => cleanupIdleUsers(), 5 * 60 * 1000);
if (typeof idleSweepInterval.unref === 'function') {
  idleSweepInterval.unref();
}

function appendHistory(chatId, role, content) {
  if (role !== 'user' && role !== 'assistant') return;
  if (typeof content !== 'string' || !content.trim()) return;
  let cleanContent = content.trim();
  if (cleanContent.includes('data:image/') || cleanContent.length > 5000) {
    cleanContent = '[Materi visual/gambar terlampir]';
  }
  const s = getState(chatId);
  s.history.push({ role, content: cleanContent });
  if (s.history.length > 8) {
    s.history = s.history.slice(-8);
  }
}

function clearHistory(chatId) {
  const s = getState(chatId);
  s.history = [];
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

function splitIntoChunks(text, maxLen = 4000) {
  if (!text || text.length <= maxLen) return [text || ''];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (splitIdx === -1 || splitIdx < maxLen * 0.4) {
      splitIdx = remaining.lastIndexOf('\n', maxLen);
    }
    if (splitIdx === -1 || splitIdx < maxLen * 0.4) {
      splitIdx = remaining.lastIndexOf('. ', maxLen);
      if (splitIdx !== -1) splitIdx += 1;
    }
    if (splitIdx === -1 || splitIdx < maxLen * 0.4) {
      splitIdx = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitIdx === -1 || splitIdx < 1) {
      splitIdx = maxLen;
    }
    chunks.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

async function sendChunk(bot, chatId, text, opts = {}) {
  try {
    return await bot.sendMessage(chatId, text, { ...opts, parse_mode: 'Markdown' });
  } catch (e) {
    if (e.response && e.response.body && e.response.body.description &&
        /parse/i.test(e.response.body.description)) {
      return await bot.sendMessage(chatId, text.replace(/[*_`]/g, ''), opts);
    }
    throw e;
  }
}

// Send message with Unicode-converted math; split chunks <= 4000 chars; try Markdown, else plain text
async function sendSmart(bot, chatId, text, opts = {}) {
  const raw = typeof text === 'string' ? text : String(text || '');
  const clean = raw.trim();
  const safe = latexToUnicode(clean || ERROR_MSG);
  const chunks = splitIntoChunks(safe, 4000);

  let lastSent = null;
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const chunkOpts = isLast ? opts : { ...opts, reply_markup: undefined };
    lastSent = await sendChunk(bot, chatId, chunks[i], chunkOpts);
  }
  return lastSent;
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
    { command: 'quiz', description: 'Buat kuis pilihan ganda dari materi' },
    { command: 'reset', description: 'Reset ingatan percakapan & materi' },
    { command: 'ceklimit', description: 'Cek sisa limit kuis harian' },
    { command: 'iduser', description: 'Lihat ID Telegram untuk upgrade' },
  ];
  if (typeof bot.setMyCommands === 'function') {
    bot.setMyCommands(BOT_COMMANDS).catch((err) => {
      console.error('Failed to set Telegram commands menu:', err.message);
    });
  }

  bot.onText(/^\/quiz(?:@\w+)?(?:\s+([\s\S]*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from ? msg.from.id : chatId;
    const s = getState(chatId);

    // Concurrency check
    if (s.state === 'QUIZ_ACTIVE' || s.state === 'EXPLAIN_ACTIVE') {
      bot.sendMessage(chatId, 'Sabar ya, lagi diproses nih... ⏳');
      return;
    }

    // Locked quiz in progress check
    if (s.state === 'AWAITING_ANSWER' && s.quiz) {
      bot.sendMessage(chatId, 'Nope, soalnya udah dikunci 🔒 Selesaikan dulu kuis yang lagi aktif ya!');
      return;
    }

    // Quota check
    if (!canTakeQuiz(userId)) {
      bot.sendMessage(
        chatId,
        'Limit Quiz kamu sudah habis! Mau upgrade limit untuk persiapan ujian besok? Cuma 10.000 buat 7 Hari, Chat owner @satirvx'
      );
      return;
    }

    const rawArgs = match && match[1] ? match[1].trim() : '';
    const userText = rawArgs;
    const cleanMaterial = userText.slice(0, 1500); // Cap input at 1500 characters

    // Direct material provided in command argument
    if (cleanMaterial) {
      if (cleanMaterial.length > 400) {
        clearHistory(chatId);
      }
      setState(chatId, {
        material: cleanMaterial,
        imageBase64: null,
      });
      await handleQuiz(chatId);
      return;
    }

    // Use pre-existing material or image
    if (s.material || s.imageBase64) {
      await handleQuiz(chatId);
      return;
    }

    // Fallback to conversation history if available
    if (s.history && s.history.length > 0) {
      const historyMaterial = s.history
        .map((h) => `${h.role === 'user' ? 'Topik' : 'Penjelasan'}: ${h.content}`)
        .join('\n\n');
      setState(chatId, {
        material: historyMaterial,
        imageBase64: null,
      });
      await handleQuiz(chatId);
      return;
    }

    // No material available
    await sendSmart(
      bot,
      chatId,
      'Materinya belum ada nih! 📚\nKirim catatan atau materi kamu dulu, atau langsung ketik:\n`/quiz <materi kamu>`'
    );
  });

  bot.onText(/\/reset/, (msg) => {
    const chatId = msg.chat.id;
    clearHistory(chatId);
    setState(chatId, {
      state: 'IDLE',
      quiz: null,
      messageId: null,
      material: '',
      imageBase64: null,
    });
    bot.sendMessage(
      chatId,
      'Memori obrolan berhasil di-reset! Kirim materi atau pertanyaan baru yuk 🚀'
    );
  });

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    clearHistory(chatId);
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
        `Status: ⭐ Premium (Unlimited Kuis, Penjelasan, & Gambar)\n` +
        `Aktif sampai: ${expiryDate} WIB\n\n` +
        `Gaskeun latihan sepuasnya tanpa batas harian! 🚀`
      );
      return;
    }

    const quizRemaining = quota.quiz ? quota.quiz.remaining : quota.remaining;
    const quizTotal = quota.quiz ? quota.quiz.total : quota.total;
    const explainRemaining = quota.explain ? quota.explain.remaining : 15;
    const explainTotal = quota.explain ? quota.explain.total : 15;
    const imageRemaining = quota.image ? quota.image.remaining : 5;
    const imageTotal = quota.image ? quota.image.total : 5;

    const quizDisplay = quizRemaining === 0 ? `0/${quizTotal} (Habis)` : `${quizRemaining}/${quizTotal}`;
    const explainDisplay = explainRemaining === 0 ? `0/${explainTotal} (Habis)` : `${explainRemaining}/${explainTotal}`;
    const imageDisplay = imageRemaining === 0 ? `0/${imageTotal} (Habis)` : `${imageRemaining}/${imageTotal}`;

    let text = `📊 *Status Limit Kamu*\n\n` +
      `Status: Free\n` +
      `Sisa Kuis Hari Ini: ${quizDisplay}\n` +
      `Sisa Penjelasan Hari Ini: ${explainDisplay}\n` +
      `Sisa Upload Gambar Hari Ini: ${imageDisplay}\n` +
      `Reset setiap 00:00 WIB\n\n`;

    if (quizRemaining === 0) {
      text += 'Limit Quiz kamu sudah habis! Mau upgrade limit untuk persiapan ujian besok? Cuma 10.000 buat 7 Hari, Chat owner @satirvx';
    } else {
      text += 'Kirim catatan atau materi kamu ke sini buat mulai kuis! 🚀';
    }

    await sendSmart(bot, msg.chat.id, text);
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

  bot.onText(/^\/backup(?:@\w+)?(?:\s.*)?$/, async (msg) => {
    const adminId = process.env.ADMIN_ID;
    if (!adminId || !msg.from || String(msg.from.id) !== String(adminId)) {
      bot.sendMessage(msg.chat.id, 'Akses ditolak. Perintah ini cuma buat admin.');
      return;
    }

    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, 'Siap, lagi nyiapin file backup data... ⏳');

    try {
      await performBackup(bot, chatId);
    } catch (err) {
      console.error('[Backup] Manual backup failed:', err.message);
      bot.sendMessage(chatId, `⚠️ Gagal bikin backup: ${err.message}`);
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
      const userId = msg.from ? msg.from.id : chatId;
      if (!canUploadImage(userId)) {
        bot.sendMessage(
          chatId,
          'Limit upload Gambar kamu sudah habis! Mau upgrade limit untuk persiapan ujian besok? Cuma 10.000 buat 7 Hari, Chat owner @satirvx'
        );
        return;
      }

      clearHistory(chatId);
      try {
        const fileId = isPhoto ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
        const mimeType = isImageDoc ? msg.document.mime_type : 'image/jpeg';
        const imageBase64 = await downloadTelegramImageAsBase64(bot, fileId, mimeType);
        const userText = typeof msg.caption === 'string' ? msg.caption.trim() : '';
        const cleanMaterial = userText.slice(0, 1500); // Cap input at 1500 characters
        recordImageUsage(userId);

        setState(chatId, {
          state: 'IDLE',
          quiz: null,
          messageId: null,
          material: cleanMaterial,
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

    // Text material routing: check if fresh material or contextual follow-up question
    const userText = (msg.text || '').trim();
    const cleanMaterial = userText.slice(0, 1500); // Cap input at 1500 characters
    if (cleanMaterial.length > 400) {
      clearHistory(chatId);
      setState(chatId, {
        state: 'IDLE',
        quiz: null,
        messageId: null,
        material: cleanMaterial,
        imageBase64: null,
      });

      bot.sendMessage(
        chatId,
        'Oke, dapet materinya! 📥\nMau gw apain nih?',
        { reply_markup: CHOICE_KEYBOARD }
      );
      return;
    }

    if ((s.state === 'IDLE' || s.state === 'QUIZ_DONE') && s.history && s.history.length > 0) {
      handleFollowUp(chatId, cleanMaterial);
      return;
    }

    setState(chatId, {
      state: 'IDLE',
      quiz: null,
      messageId: null,
      material: cleanMaterial,
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

        if (data === 'CHOICE_EXPLAIN' && !canExplain(chatId)) {
          await bot.answerCallbackQuery(query.id);
          await bot.editMessageReplyMarkup(undefined, {
            chat_id: chatId,
            message_id: query.message.message_id,
          }).catch(() => {});
          bot.sendMessage(
            chatId,
            'Limit Penjelasan kamu sudah habis! Mau upgrade limit untuk persiapan ujian besok? Cuma 10.000 buat 7 Hari, Chat owner @satirvx'
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

        if (data === 'CHOICE_QUIZ') {
          handleQuiz(chatId);
        } else {
          const typing = setInterval(() => {
            bot.sendChatAction(chatId, 'typing').catch(() => {});
          }, 4000);
          handleExplain(chatId, material, imageBase64).finally(() => clearInterval(typing));
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
      const MAX_CHARS = 1500;
      const material = (s.material || '').slice(0, MAX_CHARS);
      const prompt =
        `Materi:\n${material}\n\n` +
        `Pertanyaan kuis yang DIKUNCI (JANGAN diubah):\n${quiz.question}\n\nPilihan:\n${optionsText}\n\n` +
        `Pesan user: "${userMessage}"`;
      const reply = await ask(prompt, HINT_SYSTEM_PROMPT, {
        primaryModel: MODEL_DEEPSEEK,
        fallbackModel: MODEL_MIMO,
        maxTokens: 400,
        timeoutMs: 30000,
        temperature: 0.2,
      });
      await sendSmart(bot, chatId, cleanMarkdown(reply));
    } catch (e) {
      console.error('Hint error:', e);
      await sendSmart(bot, chatId, 'Nope, soalnya udah dikunci 🔒 Fokus jawab yang ada ya, lu pasti bisa! 💪');
    } finally {
      clearInterval(typing);
    }
  }

  async function handleFollowUp(chatId, question) {
    if (!canExplain(chatId)) {
      bot.sendMessage(
        chatId,
        'Limit Penjelasan kamu sudah habis! Mau upgrade limit untuk persiapan ujian besok? Cuma 10.000 buat 7 Hari, Chat owner @satirvx'
      );
      return;
    }

    const s = getState(chatId);
    setState(chatId, { state: 'EXPLAIN_ACTIVE' });
    const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000);

    try {
      const cleanQuestion = (question || '').slice(0, 1500);
      const reply = await ask(cleanQuestion, EXPLAIN_SYSTEM_PROMPT, {
        primaryModel: MODEL_DEEPSEEK,
        fallbackModel: MODEL_MIMO,
        maxTokens: 2500,
        timeoutMs: 75000,
        history: s.history,
        temperature: 0.2,
      });

      appendHistory(chatId, 'user', cleanQuestion);
      appendHistory(chatId, 'assistant', reply);
      recordExplainUsage(chatId);
      setState(chatId, { state: 'IDLE' });
      await sendSmart(bot, chatId, cleanMarkdown(reply));
    } catch (e) {
      console.error('Follow-up error:', e);
      setState(chatId, { state: 'IDLE' });
      bot.sendMessage(chatId, AI_BUSY_MSG).catch(() => {});
    } finally {
      clearInterval(typing);
    }
  }

  async function handleQuiz(chatId) {
    const s = getState(chatId);
    setState(chatId, { state: 'QUIZ_ACTIVE' });
    bot.sendMessage(chatId, 'Oke, lagi gw bikinin soal nih... ⏳');
    const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000);

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
    } finally {
      clearInterval(typing);
    }
  }

  async function handleExplain(chatId, material, imageBase64 = null) {
    setState(chatId, { state: 'EXPLAIN_ACTIVE' });
    bot.sendMessage(chatId, 'Oke, lagi gw jelasin materinya nih... ⏳');

    try {
      const MAX_CHARS = 1500;
      const trimmed = (material || '').slice(0, MAX_CHARS);
      const complexity = classifyComplexity(trimmed);
      const isHeavy = Boolean(imageBase64) || complexity === 'heavy';
      const primaryModel = MODEL_DEEPSEEK;
      const fallbackModel = imageBase64 ? null : MODEL_MIMO;
      const maxTokens = isHeavy ? 3200 : 2500;
      const timeoutMs = isHeavy ? 90000 : 75000;

      const prompt = imageBase64 && (!trimmed || !trimmed.trim())
        ? 'Jelaskan materi yang ada pada gambar berikut secara bertahap dan mudah dipahami.'
        : `Materi dari user:\n\n${trimmed}`;

      const explanation = await ask(
        prompt,
        EXPLAIN_SYSTEM_PROMPT,
        { primaryModel, fallbackModel, maxTokens, timeoutMs, imageBase64, temperature: 0.2 }
      );

      const userDescriptor = trimmed || (imageBase64 ? '[Materi visual/gambar terlampir]' : '');
      if (userDescriptor) {
        appendHistory(chatId, 'user', userDescriptor);
      }
      appendHistory(chatId, 'assistant', explanation);

      await sendSmart(bot, chatId, cleanMarkdown(explanation));
      recordExplainUsage(chatId);
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
  appendHistory,
  clearHistory,
  cleanupIdleUsers,
  IDLE_TTL_MS,
  downloadTelegramImageAsBase64,
  sendSmart,
  splitIntoChunks,
};
