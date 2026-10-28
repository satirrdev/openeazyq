const { ask, extractJson, MODEL_DEEPSEEK, MODEL_MIMO } = require('./llm');
const { latexToUnicode } = require('./math');
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
  const safe = latexToUnicode(typeof text === 'string' ? text : String(text));
  try {
    return await bot.sendMessage(chatId, safe, { ...opts, parse_mode: 'Markdown' });
  } catch (e) {
    if (e.response && e.response.body && e.response.body.description &&
        /parse/i.test(e.response.body.description)) {
      return bot.sendMessage(chatId, safe.replace(/[*_`]/g, ''), opts);
    }
    throw e;
  }
}

function register(bot) {
  bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    setState(chatId, { state: 'IDLE', quiz: null, messageId: null });
    bot.sendMessage(
      chatId,
      'Hai! 👋 Gw *GampangBot*, asisten belajar kompetitiflu.\n\n' +
        'Kirim aja materi belajar, catatan, atau syllabus dong ke sini.\n' +
        'Nanti gw bisa:\n' +
        '📚 Bikinin kuis pilihan ganda\n' +
        '🧠 Jelasin materi pake gaya anak SD (santai & gampang)\n\n' +
        'Gaskeun, kirim materinya! 🚀',
      { parse_mode: 'Markdown' }
    );
  });

  bot.on('message', (msg) => {
    // Ignore commands (/start etc.) and photo/media pairs without text
    if (!msg.text || msg.text.startsWith('/')) return;

    const chatId = msg.chat.id;
    const s = getState(chatId);

    // Check if an AI action is already actively computing for this user
    if (s.state === 'QUIZ_ACTIVE' || s.state === 'EXPLAIN_ACTIVE') {
      bot.sendMessage(chatId, 'Sabar ya, lagi diproses nih... ⏳');
      return;
    }

    // Quiz is locked while waiting for an answer: never change the question
    if (s.state === 'AWAITING_ANSWER' && s.quiz) {
      handleHint(chatId, msg.text);
      return;
    }

    // If user sends new material while awaiting answer, reset to fresh material
    setState(chatId, {
      state: 'IDLE',
      quiz: null,
      messageId: null,
      material: msg.text,
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
        await bot.answerCallbackQuery(query.id);
        const material = s.material;
        if (!material) {
          bot.sendMessage(chatId, 'Materinya belum ada nih, kirim dulu dong 🙏');
          return;
        }
        // Acknowledge & clear old keyboard
        await bot.editMessageReplyMarkup(undefined, {
          chat_id: chatId,
          message_id: query.message.message_id,
        }).catch(() => {});

        setState(chatId, { material, choice: data });

        // Show typing while the AI works (reasoning model can take ~1 min)
        const typing = setInterval(() => {
          bot.sendChatAction(chatId, 'typing').catch(() => {});
        }, 4000);
        const stopTyping = () => clearInterval(typing);

        if (data === 'CHOICE_QUIZ') {
          handleQuiz(chatId).finally(stopTyping);
        } else {
          handleExplain(chatId, material).finally(stopTyping);
        }
        return;
      }

      // Answer click: A/B/C/D
      if (data.startsWith('ANS_')) {
        const answer = data.slice(4); // 'A'..'D'
        await bot.answerCallbackQuery(query.id);

        if (s.state !== 'AWAITING_ANSWER' || !s.quiz) {
          // Late/duplicate click — quiz already answered
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

        sendSmart(
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
        primaryModel: MODEL_MIMO,
        fallbackModel: MODEL_DEEPSEEK,
        maxTokens: 250,
        timeoutMs: 30000,
      });
      sendSmart(bot, chatId, cleanMarkdown(reply));
    } catch (e) {
      console.error('Hint error:', e);
      sendSmart(bot, chatId, 'Nope, soalnya udah dikunci 🔒 Fokus jawab yang ada ya, lu pasti bisa! 💪');
    } finally {
      clearInterval(typing);
    }
  }

  async function handleQuiz(chatId) {
    const s = getState(chatId);
    setState(chatId, { state: 'QUIZ_ACTIVE' });
    bot.sendMessage(chatId, 'Oke, lagi gw bikinin soal nih... ⏳');

    try {
      const quiz = await generateQuiz(s.material);
      const sent = await sendSmart(bot, chatId, buildQuestionText(quiz), {
        reply_markup: buildQuizKeyboard(),
      });
      setState(chatId, { state: 'AWAITING_ANSWER', quiz, messageId: sent.message_id });
    } catch (e) {
      console.error('Quiz generation error:', e);
      setState(chatId, { state: 'IDLE', quiz: null });
      bot.sendMessage(chatId, AI_BUSY_MSG);
    }
  }

  async function handleExplain(chatId, material) {
    setState(chatId, { state: 'EXPLAIN_ACTIVE' });
    bot.sendMessage(chatId, 'Oke, lagi gw jelasin materinya nih... ⏳');

    try {
      const MAX_CHARS = 3000;
      const trimmed = material.slice(0, MAX_CHARS);
      const complexity = classifyComplexity(material);
      const isHeavy = complexity === 'heavy';
      const primaryModel = isHeavy ? MODEL_DEEPSEEK : MODEL_MIMO;
      const fallbackModel = isHeavy ? MODEL_MIMO : MODEL_DEEPSEEK;
      const maxTokens = isHeavy ? 1000 : 750;
      const timeoutMs = isHeavy ? 60000 : 45000;

      const explanation = await ask(
        `Materi dari user:\n\n${trimmed}`,
        EXPLAIN_SYSTEM_PROMPT,
        { primaryModel, fallbackModel, maxTokens, timeoutMs }
      );
      sendSmart(bot, chatId, cleanMarkdown(explanation));
      setState(chatId, { state: 'IDLE' });
    } catch (e) {
      console.error('Explain error:', e);
      setState(chatId, { state: 'IDLE' });
      bot.sendMessage(chatId, AI_BUSY_MSG);
    }
  }
}

module.exports = { register, getState, setState };
