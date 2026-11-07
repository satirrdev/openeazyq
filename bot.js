const { ask, extractJson, MODEL_DEEPSEEK, MODEL_MIMO } = require('./llm');
const { latexToUnicode } = require('./math');
const store = require('./store');
const {
  canTakeQuiz,
  canExplain,
  canUploadImage,
  reserveQuota,
  releaseQuota,
  recordQuizUsage,
  recordExplainUsage,
  recordImageUsage,
  upgradeUser,
  getUserQuota,
  getAllUsers,
  getUserLanguage,
  setUserLanguage,
  DAILY_EXPLAIN_LIMIT,
  DAILY_IMAGE_LIMIT,
} = store;
const {
  EXPLAIN_SYSTEM_PROMPT,
  HINT_SYSTEM_PROMPT,
  ERROR_MSG,
  generateQuiz,
  classifyComplexity,
  buildQuizKeyboard,
  buildQuestionText,
} = require('./quiz');
const {
  t,
  getQuizPrompt,
  getExplainPrompt,
  getHintPrompt,
} = require('./i18n');
const { responseCache } = require('./cache');
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
let botInstance = null;
let isBroadcastingActive = false;

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

function getChoiceKeyboard(lang = 'en') {
  return {
    inline_keyboard: [
      [
        { text: t(lang, 'btn_quiz'), callback_data: 'CHOICE_QUIZ' },
        { text: t(lang, 'btn_explain'), callback_data: 'CHOICE_EXPLAIN' },
      ],
    ],
  };
}

const CHOICE_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '📚 Bikin Kuis', callback_data: 'CHOICE_QUIZ' },
      { text: '🧠 Jelasin Materi', callback_data: 'CHOICE_EXPLAIN' },
    ],
  ],
};

const LANGUAGE_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '🇬🇧 English', callback_data: 'LANG_en' },
      { text: '🇮🇩 Bahasa Indonesia', callback_data: 'LANG_id' },
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

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB cap

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
    const rawLen = res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : null;
    const contentLength = rawLen ? parseInt(rawLen, 10) : NaN;
    if (!isNaN(contentLength) && contentLength > MAX_IMAGE_BYTES) {
      controller.abort();
      throw new Error('Image file is too large (maximum 5MB)');
    }
    const contentType = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || defaultMime;
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer && arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
      throw new Error('Image file is too large (maximum 5MB)');
    }
    const base64Data = Buffer.from(arrayBuffer).toString('base64');
    return `data:${contentType};base64,${base64Data}`;
  } finally {
    clearTimeout(timer);
  }
}

function register(bot) {
  botInstance = bot;
  if (!bot) return;

  const BOT_COMMANDS = [
    { command: 'start', description: 'Mulai bot & panduan belajar' },
    { command: 'quiz', description: 'Buat kuis pilihan ganda dari materi' },
    { command: 'reset', description: 'Reset ingatan percakapan & materi' },
    { command: 'language', description: 'Change bot language / Ubah bahasa bot' },
    { command: 'ceklimit', description: 'Cek sisa limit kuis harian' },
    { command: 'iduser', description: 'Lihat ID Telegram untuk upgrade' },
  ];
  if (typeof bot.setMyCommands === 'function') {
    bot.setMyCommands(BOT_COMMANDS).catch((err) => {
      console.error('Failed to set Telegram commands menu:', err.message);
    });
  }

  bot.onText(/^\/language(?:@\w+)?$/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from ? msg.from.id : chatId;
    const lang = getUserLanguage(userId);
    bot.sendMessage(chatId, t(lang, 'language_select'), {
      reply_markup: LANGUAGE_KEYBOARD,
    });
  });

  bot.onText(/^\/quiz(?:@\w+)?(?:\s+([\s\S]*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from ? msg.from.id : chatId;
    const lang = getUserLanguage(userId);
    const s = getState(chatId);

    // Concurrency check
    if (s.state === 'QUIZ_ACTIVE' || s.state === 'EXPLAIN_ACTIVE') {
      bot.sendMessage(chatId, t(lang, 'processing'));
      return;
    }

    // Locked quiz in progress check
    if (s.state === 'AWAITING_ANSWER' && s.quiz) {
      bot.sendMessage(chatId, t(lang, 'quiz_locked'));
      return;
    }

    // Quota check
    if (!canTakeQuiz(userId)) {
      bot.sendMessage(
        chatId,
        t(lang, 'quota_quiz_exhausted')
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
      await handleQuiz(chatId, userId);
      return;
    }

    // Use pre-existing material or image
    if (s.material || s.imageBase64) {
      await handleQuiz(chatId, userId);
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
      await handleQuiz(chatId, userId);
      return;
    }

    // No material available
    await sendSmart(
      bot,
      chatId,
      t(lang, 'empty_quiz_prompt')
    );
  });

  bot.onText(/^\/(?:explain|jelasin|jelaskan)(?:@\w+)?(?:\s+([\s\S]*))?$/, async (msg, match) => {
    const chatId = msg.chat.id;
    const userId = msg.from ? msg.from.id : chatId;
    const lang = getUserLanguage(userId);
    const s = getState(chatId);

    if (s.state === 'QUIZ_ACTIVE' || s.state === 'EXPLAIN_ACTIVE') {
      bot.sendMessage(chatId, t(lang, 'processing'));
      return;
    }

    if (s.state === 'AWAITING_ANSWER' && s.quiz) {
      bot.sendMessage(chatId, t(lang, 'quiz_locked'));
      return;
    }

    if (!canExplain(userId)) {
      bot.sendMessage(
        chatId,
        t(lang, 'quota_explain_exhausted')
      );
      return;
    }

    const rawArgs = match && match[1] ? match[1].trim() : '';
    const cleanMaterial = rawArgs.slice(0, 1500);

    if (cleanMaterial) {
      if (cleanMaterial.length > 400) {
        clearHistory(chatId);
      }
      setState(chatId, {
        material: cleanMaterial,
        imageBase64: null,
      });
      await handleExplain(chatId, cleanMaterial, null, userId);
      return;
    }

    if (s.material || s.imageBase64) {
      await handleExplain(chatId, s.material, s.imageBase64, userId);
      return;
    }

    if (s.history && s.history.length > 0) {
      const historyMaterial = s.history
        .map((h) => `${h.role === 'user' ? 'Topik' : 'Penjelasan'}: ${h.content}`)
        .join('\n\n');
      await handleExplain(chatId, historyMaterial, null, userId);
      return;
    }

    await sendSmart(
      bot,
      chatId,
      t(lang, 'empty_quiz_prompt')
    );
  });

  bot.onText(/\/reset/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from ? msg.from.id : chatId;
    const lang = getUserLanguage(userId);
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
      t(lang, 'reset_done')
    );
  });

  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from ? msg.from.id : chatId;
    const lang = getUserLanguage(userId);
    clearHistory(chatId);
    setState(chatId, { state: 'IDLE', quiz: null, messageId: null, imageBase64: null });
    bot.sendMessage(
      chatId,
      t(lang, 'start'),
      { parse_mode: 'Markdown' }
    );
  });

  bot.onText(/\/ceklimit/, async (msg) => {
    const userId = msg.from ? msg.from.id : msg.chat.id;
    const lang = getUserLanguage(userId);
    const quota = getUserQuota(userId);

    if (quota.isPremium) {
      const expiryDate = new Date(quota.premiumUntil).toLocaleString(lang === 'id' ? 'id-ID' : 'en-US', {
        timeZone: 'Asia/Jakarta',
      });
      await sendSmart(
        bot,
        msg.chat.id,
        `${t(lang, 'ceklimit_title')}\n\n` +
        `${t(lang, 'ceklimit_status_premium')}\n` +
        `${t(lang, 'ceklimit_expires', { date: expiryDate })} WIB\n\n` +
        `${lang === 'id' ? 'Gaskeun latihan sepuasnya tanpa batas harian! 🚀' : 'Enjoy unlimited practice without daily limits! 🚀'}`
      );
      return;
    }

    const quizRemaining = quota.quiz ? quota.quiz.remaining : quota.remaining;
    const quizTotal = quota.quiz ? quota.quiz.total : quota.total;
    const explainRemaining = quota.explain ? quota.explain.remaining : 15;
    const explainTotal = quota.explain ? quota.explain.total : 15;
    const imageRemaining = quota.image ? quota.image.remaining : 5;
    const imageTotal = quota.image ? quota.image.total : 5;

    const exhaustedSuffix = t(lang, 'ceklimit_exhausted_suffix');
    const quizDisplay = quizRemaining === 0 ? `0/${quizTotal}${exhaustedSuffix}` : `${quizRemaining}/${quizTotal}`;
    const explainDisplay = explainRemaining === 0 ? `0/${explainTotal}${exhaustedSuffix}` : `${explainRemaining}/${explainTotal}`;
    const imageDisplay = imageRemaining === 0 ? `0/${imageTotal}${exhaustedSuffix}` : `${imageRemaining}/${imageTotal}`;

    let text = `${t(lang, 'ceklimit_title')}\n\n` +
      `${t(lang, 'ceklimit_status_free')}\n` +
      `${t(lang, 'ceklimit_quiz', { used: quizDisplay, limit: quizTotal })}\n` +
      `${t(lang, 'ceklimit_explain', { used: explainDisplay, limit: explainTotal })}\n` +
      `${t(lang, 'ceklimit_image', { used: imageDisplay, limit: imageTotal })}\n` +
      `${t(lang, 'ceklimit_reset')}\n\n`;

    if (quizRemaining === 0) {
      text += t(lang, 'quota_quiz_exhausted');
    } else {
      text += lang === 'id' ? 'Kirim catatan atau materi kamu ke sini buat mulai kuis! 🚀' : 'Send your notes or study material here to start a quiz! 🚀';
    }

    await sendSmart(bot, msg.chat.id, text);
  });

  bot.onText(/\/iduser/, (msg) => {
    const userId = msg.from ? msg.from.id : msg.chat.id;
    const lang = getUserLanguage(userId);
    bot.sendMessage(
      msg.chat.id,
      t(lang, 'iduser_msg', { userId: msg.from.id }),
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
    const userId = msg.from ? msg.from.id : chatId;
    const lang = getUserLanguage(userId);
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
      bot.sendMessage(chatId, t(lang, 'processing'));
      return;
    }

    // Quiz is locked while waiting for an answer: never change the question
    if (s.state === 'AWAITING_ANSWER' && s.quiz) {
      const isGroup = msg.chat && (msg.chat.type === 'group' || msg.chat.type === 'supergroup');
      if (isGroup) {
        const isOwner = !s.quizUserId || String(userId) === String(s.quizUserId);
        const isReplyToBot = msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.is_bot;
        if (!isOwner || !isReplyToBot) {
          return;
        }
      }
      if (isImage) {
        bot.sendMessage(chatId, t(lang, 'quiz_locked'));
        return;
      }
      handleHint(chatId, msg.text, userId);
      return;
    }

    const isGroup = msg.chat && (msg.chat.type === 'group' || msg.chat.type === 'supergroup');
    if (isGroup) {
      const isReplyToBot = msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.is_bot;
      if (!isReplyToBot) {
        return;
      }
    }

    if (isImage) {
      if (!canUploadImage(userId)) {
        bot.sendMessage(
          chatId,
          t(lang, 'quota_image_exhausted')
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
          t(lang, 'received_image'),
          { reply_markup: getChoiceKeyboard(lang) }
        );
      } catch (err) {
        console.error('Failed to process incoming image:', err.message);
        bot.sendMessage(chatId, t(lang, 'image_download_failed'));
      }
      return;
    }

    // Text material routing: check if fresh material or contextual follow-up question
    const userText = (msg.text || '').trim();
    const cleanMaterial = userText.slice(0, 1500); // Cap input at 1500 characters

    const isExplicitExplain = /^(?:jelasin|jelaskan|terangkan|apa itu|tolong jelasin|tolong jelaskan|explain|what is|please explain)\b/i.test(cleanMaterial);
    if (isExplicitExplain) {
      if (!canExplain(userId)) {
        bot.sendMessage(
          chatId,
          t(lang, 'quota_explain_exhausted')
        );
        return;
      }
      clearHistory(chatId);
      setState(chatId, {
        material: cleanMaterial,
        imageBase64: null,
      });
      await handleExplain(chatId, cleanMaterial, null, userId);
      return;
    }

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
        t(lang, 'received_material'),
        { reply_markup: getChoiceKeyboard(lang) }
      );
      return;
    }

    if ((s.state === 'IDLE' || s.state === 'QUIZ_DONE') && s.history && s.history.length > 0) {
      handleFollowUp(chatId, cleanMaterial, userId);
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
      t(lang, 'received_material'),
      { reply_markup: getChoiceKeyboard(lang) }
    );
  });

  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from ? query.from.id : chatId;
    const lang = getUserLanguage(userId);
    const data = query.data;
    const s = getState(chatId);

    try {
      // Language selection
      if (data.startsWith('LANG_')) {
        const targetLang = data.slice(5);
        setUserLanguage(userId, targetLang);
        await bot.answerCallbackQuery(query.id, {
          text: targetLang === 'en' ? 'Language set to English!' : 'Bahasa diatur ke Bahasa Indonesia!',
        }).catch(() => {});
        await bot.editMessageReplyMarkup(undefined, {
          chat_id: chatId,
          message_id: query.message.message_id,
        }).catch(() => {});
        bot.sendMessage(chatId, t(targetLang, 'language_set'));
        return;
      }

      // Choice: quiz vs explain
      if (data === 'CHOICE_QUIZ' || data === 'CHOICE_EXPLAIN') {
        if (s.state === 'QUIZ_ACTIVE' || s.state === 'EXPLAIN_ACTIVE') {
          await bot.answerCallbackQuery(query.id, { text: t(lang, 'processing') });
          return;
        }

        if (data === 'CHOICE_QUIZ' && !canTakeQuiz(userId)) {
          await bot.answerCallbackQuery(query.id);
          await bot.editMessageReplyMarkup(undefined, {
            chat_id: chatId,
            message_id: query.message.message_id,
          }).catch(() => {});
          bot.sendMessage(
            chatId,
            t(lang, 'quota_quiz_exhausted')
          );
          return;
        }

        if (data === 'CHOICE_EXPLAIN' && !canExplain(userId)) {
          await bot.answerCallbackQuery(query.id);
          await bot.editMessageReplyMarkup(undefined, {
            chat_id: chatId,
            message_id: query.message.message_id,
          }).catch(() => {});
          bot.sendMessage(
            chatId,
            t(lang, 'quota_explain_exhausted')
          );
          return;
        }

        await bot.answerCallbackQuery(query.id);
        const material = s.material;
        const imageBase64 = s.imageBase64;
        if (!material && !imageBase64) {
          bot.sendMessage(chatId, t(lang, 'material_missing'));
          return;
        }
        // Acknowledge & clear old keyboard
        await bot.editMessageReplyMarkup(undefined, {
          chat_id: chatId,
          message_id: query.message.message_id,
        }).catch(() => {});

        setState(chatId, { choice: data });

        if (data === 'CHOICE_QUIZ') {
          handleQuiz(chatId, userId);
        } else {
          handleExplain(chatId, material, imageBase64, userId);
        }
        return;
      }

      // Answer click: A/B/C/D
      if (data.startsWith('ANS_')) {
        const answer = data.slice(4); // 'A'..'D'

        // Check if group quiz belongs to another user
        if (s.quizUserId && String(userId) !== String(s.quizUserId)) {
          await bot.answerCallbackQuery(query.id, {
            text: lang === 'id' ? 'Soal ini untuk user lain!' : 'This quiz belongs to another user!',
            show_alert: true,
          }).catch(() => {});
          return;
        }

        await bot.answerCallbackQuery(query.id);

        if (s.state !== 'AWAITING_ANSWER' || !s.quiz) {
          // Late or duplicate click: quiz already answered
          bot.sendMessage(chatId, t(lang, 'quiz_done_late'));
          return;
        }

        const quiz = s.quiz;
        const isCorrect = answer === quiz.correct_answer;

        // Mark quiz as answered (block double clicks)
        setState(chatId, { state: 'QUIZ_DONE', quizUserId: null, hintCount: 0 });

        const emoji = isCorrect ? '✅' : '❌';
        const verdict = isCorrect ? t(lang, 'quiz_correct') : t(lang, 'quiz_incorrect');
        const header = `${emoji} *${verdict}*`;
        const correctNote = isCorrect
          ? ''
          : t(lang, 'quiz_correct_answer', { letter: quiz.correct_answer, text: quiz.options[quiz.correct_answer] });
        const yourAnswer = t(lang, 'quiz_your_answer', { letter: answer, text: quiz.options[answer] });
        const nextPrompt = t(lang, 'quiz_next_prompt');

        try {
          await bot.editMessageReplyMarkup(undefined, {
            chat_id: chatId,
            message_id: query.message.message_id,
          });
        } catch (e) { /* best effort */ }

        await sendSmart(
          bot,
          chatId,
          `${header}\n${yourAnswer}${correctNote}\n\n` +
            `💡 _${quiz.explanation}_\n\n` +
            `${nextPrompt}`
        );
        return;
      }
    } catch (e) {
      console.error('callback_query handler error:', e);
      try { await bot.answerCallbackQuery(query.id, { text: 'Waduh, error. Coba lagi ya 😅' }); } catch (_) {}
      bot.sendMessage(chatId, t(lang, 'ai_busy')).catch(() => {});
    }
  });

  // Refuse quiz changes and provide a clue without leaking the answer
  const MAX_HINTS_PER_QUIZ = 2;

  async function handleHint(chatId, userMessage, userId = null) {
    const s = getState(chatId);
    const quiz = s.quiz;
    const uid = userId || chatId;
    const lang = getUserLanguage(uid);
    const isEn = lang === 'en';

    if (s.hintActive) {
      bot.sendMessage(chatId, t(lang, 'processing'));
      return;
    }

    const currentHints = s.hintCount || 0;
    if (currentHints >= MAX_HINTS_PER_QUIZ) {
      await sendSmart(bot, chatId, t(lang, 'hint_limit_reached'));
      return;
    }

    s.hintActive = true;
    s.hintCount = currentHints + 1;
    const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000);

    try {
      const optionsText = Object.entries(quiz.options)
        .map(([k, v]) => `${k}. ${v}`)
        .join('\n');
      const MAX_CHARS = 1500;
      const material = (s.material || '').slice(0, MAX_CHARS);
      const cleanMsg = (userMessage || '').trim().slice(0, 500);
      const prompt = isEn
        ? `Material:\n${material}\n\n` +
          `LOCKED quiz question (DO NOT change):\n${quiz.question}\n\nOptions:\n${optionsText}\n\n` +
          `User message: "${cleanMsg}"`
        : `Materi:\n${material}\n\n` +
          `Pertanyaan kuis yang DIKUNCI (JANGAN diubah):\n${quiz.question}\n\nPilihan:\n${optionsText}\n\n` +
          `Pesan user: "${cleanMsg}"`;
      const reply = await ask(prompt, getHintPrompt(lang), {
        primaryModel: MODEL_DEEPSEEK,
        fallbackModel: MODEL_MIMO,
        maxTokens: 400,
        timeoutMs: 30000,
        temperature: 0.2,
      });
      await sendSmart(bot, chatId, cleanMarkdown(reply));
    } catch (e) {
      console.error('Hint error:', e);
      await sendSmart(bot, chatId, t(lang, 'hint_refusal'));
    } finally {
      s.hintActive = false;
      clearInterval(typing);
    }
  }

  async function handleFollowUp(chatId, question, userId = null) {
    const uid = userId || chatId;
    const lang = getUserLanguage(uid);
    if (!canExplain(uid)) {
      bot.sendMessage(
        chatId,
        t(lang, 'quota_explain_exhausted')
      );
      return;
    }

    const s = getState(chatId);
    setState(chatId, { state: 'EXPLAIN_ACTIVE' });
    reserveQuota(uid, 'explain');
    const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000);

    try {
      const cleanQuestion = (question || '').slice(0, 1500);
      const reply = await ask(cleanQuestion, getExplainPrompt(lang), {
        primaryModel: MODEL_DEEPSEEK,
        fallbackModel: MODEL_MIMO,
        maxTokens: 2500,
        timeoutMs: 75000,
        history: s.history,
        temperature: 0.2,
      });

      appendHistory(chatId, 'user', cleanQuestion);
      appendHistory(chatId, 'assistant', reply);
      recordExplainUsage(uid);
      setState(chatId, { state: 'IDLE' });
      await sendSmart(bot, chatId, cleanMarkdown(reply));
    } catch (e) {
      releaseQuota(uid, 'explain');
      console.error('Follow-up error:', e);
      setState(chatId, { state: 'IDLE' });
      bot.sendMessage(chatId, t(lang, 'ai_busy')).catch(() => {});
    } finally {
      clearInterval(typing);
    }
  }

  async function handleQuiz(chatId, userId = null) {
    const uid = userId || chatId;
    const lang = getUserLanguage(uid);
    const s = getState(chatId);
    setState(chatId, { state: 'QUIZ_ACTIVE' });
    reserveQuota(uid, 'quiz');
    bot.sendMessage(chatId, t(lang, 'generating_quiz'));
    const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000);

    try {
      const quiz = await generateQuiz(s.material, s.imageBase64, { lang });
      const sent = await sendSmart(bot, chatId, buildQuestionText(quiz, lang), {
        reply_markup: buildQuizKeyboard(),
      });
      recordQuizUsage(uid);
      setState(chatId, {
        state: 'AWAITING_ANSWER',
        quiz,
        messageId: sent.message_id,
        imageBase64: null,
        quizUserId: uid,
        hintCount: 0,
      });
    } catch (e) {
      releaseQuota(uid, 'quiz');
      console.error('Quiz generation error:', e);
      setState(chatId, { state: 'IDLE', quiz: null, imageBase64: null });
      bot.sendMessage(chatId, t(lang, 'ai_busy')).catch(() => {});
    } finally {
      clearInterval(typing);
    }
  }

  async function handleExplain(chatId, material, imageBase64 = null, userId = null) {
    const uid = userId || chatId;
    const lang = getUserLanguage(uid);
    setState(chatId, { state: 'EXPLAIN_ACTIVE' });
    reserveQuota(uid, 'explain');
    bot.sendMessage(chatId, t(lang, 'explaining'));
    const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000);

    try {
      const MAX_CHARS = 1500;
      const trimmed = (material || '').slice(0, MAX_CHARS);

      // Check token/response cache
      const cacheKey = !imageBase64 && trimmed ? responseCache.makeKey('explain', lang, trimmed) : null;
      if (cacheKey) {
        const cached = responseCache.get(cacheKey);
        if (cached) {
          const userDescriptor = trimmed || '';
          if (userDescriptor) {
            appendHistory(chatId, 'user', userDescriptor);
          }
          appendHistory(chatId, 'assistant', cached);
          await sendSmart(bot, chatId, cleanMarkdown(cached));
          recordExplainUsage(uid);
          setState(chatId, { state: 'IDLE', imageBase64: null });
          return;
        }
      }

      const complexity = classifyComplexity(trimmed);
      const isHeavy = Boolean(imageBase64) || complexity === 'heavy';
      const primaryModel = MODEL_DEEPSEEK;
      const fallbackModel = imageBase64 ? null : MODEL_MIMO;
      const maxTokens = isHeavy ? 3200 : 2500;
      const timeoutMs = isHeavy ? 90000 : 75000;
      const isEn = lang === 'en';

      const prompt = imageBase64 && (!trimmed || !trimmed.trim())
        ? (isEn ? 'Explain the material in the following image step-by-step and concisely.' : 'Jelaskan materi yang ada pada gambar berikut secara bertahap dan mudah dipahami.')
        : (isEn ? `Study material from user:\n\n${trimmed}` : `Materi dari user:\n\n${trimmed}`);

      const explanation = await ask(
        prompt,
        getExplainPrompt(lang),
        { primaryModel, fallbackModel, maxTokens, timeoutMs, imageBase64, temperature: 0.2 }
      );

      if (cacheKey) {
        responseCache.set(cacheKey, explanation);
      }

      const userDescriptor = trimmed || (imageBase64 ? (isEn ? '[Visual/image material attached]' : '[Materi visual/gambar terlampir]') : '');
      if (userDescriptor) {
        appendHistory(chatId, 'user', userDescriptor);
      }
      appendHistory(chatId, 'assistant', explanation);

      await sendSmart(bot, chatId, cleanMarkdown(explanation));
      recordExplainUsage(uid);
      setState(chatId, { state: 'IDLE', imageBase64: null });
    } catch (e) {
      releaseQuota(uid, 'explain');
      console.error('Explain error:', e);
      setState(chatId, { state: 'IDLE', imageBase64: null });
      bot.sendMessage(chatId, t(lang, 'ai_busy')).catch(() => {});
    } finally {
      clearInterval(typing);
    }
  }
}

function isBroadcasting() {
  return isBroadcastingActive;
}

function setBotInstance(bot) {
  botInstance = bot;
}

function getBotInstance() {
  return botInstance;
}

async function sendDirectMessage(userId, text, opts = {}) {
  if (!botInstance) {
    throw new Error('Bot instance belum diinisialisasi');
  }
  if (!userId) {
    throw new Error('User ID tidak boleh kosong');
  }
  try {
    const result = await sendSmart(botInstance, userId, text, opts);
    return {
      success: true,
      messageId: result?.message_id,
    };
  } catch (err) {
    throw new Error(`Gagal mengirim pesan ke ${userId}: ${err.message || String(err)}`);
  }
}

async function broadcastMessage(text, options = {}) {
  if (isBroadcastingActive) {
    throw new Error('Broadcast sedang berjalan');
  }
  if (!botInstance) {
    throw new Error('Bot instance belum diinisialisasi');
  }
  if (!text || typeof text !== 'string' || !text.trim()) {
    throw new Error('Pesan broadcast tidak boleh kosong');
  }

  isBroadcastingActive = true;
  try {
    const allUsers = typeof store.getAllUsers === 'function'
      ? store.getAllUsers()
      : (typeof getAllUsers === 'function' ? getAllUsers() : []);
    const validUsers = allUsers.filter((u) => {
      if (!u || u.userId === undefined || u.userId === null) return false;
      const strId = String(u.userId).trim();
      return /^-?\d+$/.test(strId);
    });

    const delayMs = typeof options.delayMs === 'number'
      ? options.delayMs
      : (typeof options.delay === 'number' ? options.delay : 60);

    let sent = 0;
    const failures = [];

    for (let i = 0; i < validUsers.length; i++) {
      const user = validUsers[i];
      try {
        await sendSmart(botInstance, user.userId, text);
        sent++;
      } catch (err) {
        failures.push({
          userId: user.userId,
          error: err.message || String(err),
        });
      }

      if (i < validUsers.length - 1 && delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    return {
      total: validUsers.length,
      sent,
      failed: failures.length,
      failures,
    };
  } finally {
    isBroadcastingActive = false;
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
  sendDirectMessage,
  broadcastMessage,
  isBroadcasting,
  setBotInstance,
  getBotInstance,
};
