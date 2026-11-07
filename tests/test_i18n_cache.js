// tests/test_i18n_cache.js - Test suite for i18n & Response Token Cache
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const {
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
} = require('../i18n');

const { ResponseCache, responseCache } = require('../cache');
const store = require('../store');
const {
  register: registerBot,
  getState,
  setState,
} = require('../bot');
const { generateQuiz, buildQuestionText } = require('../quiz');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

let originalUsersExisted = false;
let originalUsersContent = null;

if (fs.existsSync(USERS_FILE)) {
  originalUsersExisted = true;
  originalUsersContent = fs.readFileSync(USERS_FILE, 'utf8');
}

function restoreStore() {
  try {
    if (originalUsersExisted) {
      fs.writeFileSync(USERS_FILE, originalUsersContent, 'utf8');
    } else if (fs.existsSync(USERS_FILE)) {
      fs.unlinkSync(USERS_FILE);
    }
  } catch (_) {}
}

function createMockBot() {
  const handlers = {};
  const sentMessages = [];
  const answeredCallbacks = [];
  const editedMarkups = [];

  const mockBot = {
    onText: (regex, cb) => {
      handlers[regex.toString()] = { regex, cb };
    },
    on: (evt, cb) => {
      handlers[evt] = cb;
    },
    sendMessage: async (chatId, text, opts = {}) => {
      const msg = { chatId, text, opts, message_id: 1000 + sentMessages.length };
      sentMessages.push(msg);
      return msg;
    },
    answerCallbackQuery: async (id, opts = {}) => {
      answeredCallbacks.push({ id, opts });
      return true;
    },
    editMessageReplyMarkup: async (markup, opts = {}) => {
      editedMarkups.push({ markup, opts });
      return true;
    },
    sendChatAction: async () => true,
    setMyCommands: async () => true,
  };

  registerBot(mockBot);

  const dispatchMessage = async (msg) => {
    for (const key of Object.keys(handlers)) {
      const entry = handlers[key];
      if (entry && entry.regex && entry.cb && msg.text) {
        const match = msg.text.match(entry.regex);
        if (match) {
          await entry.cb(msg, match);
          return;
        }
      }
    }
    if (handlers.message) {
      await handlers.message(msg);
    }
  };

  const dispatchCallback = async (query) => {
    if (handlers.callback_query) {
      await handlers.callback_query(query);
    }
  };

  return { mockBot, dispatchMessage, dispatchCallback, sentMessages, answeredCallbacks, editedMarkups };
}

async function runTests() {
  console.log('=== Running i18n & Cache Verification Tests ===\n');

  try {
    // ----------------------------------------------------
    // Suite 1: i18n Dictionary & Normalization
    // ----------------------------------------------------
    console.log('Suite 1: i18n Dictionary & Normalization');

    assert.strictEqual(DEFAULT_LANGUAGE, 'en', 'Default language must be en');
    assert.deepStrictEqual(SUPPORTED_LANGUAGES, ['en', 'id'], 'Supported languages must be en and id');

    assert.strictEqual(normalizeLang(null), 'en');
    assert.strictEqual(normalizeLang(undefined), 'en');
    assert.strictEqual(normalizeLang(''), 'en');
    assert.strictEqual(normalizeLang('en'), 'en');
    assert.strictEqual(normalizeLang('EN'), 'en');
    assert.strictEqual(normalizeLang('id'), 'id');
    assert.strictEqual(normalizeLang('ID'), 'id');
    assert.strictEqual(normalizeLang('fr'), 'en', 'Unsupported language defaults to en');

    // Interpolation test
    const formattedEn = t('en', 'quiz_your_answer', { letter: 'A', text: 'Velocity' });
    assert.strictEqual(formattedEn, 'Your answer: *A. Velocity*');

    const formattedId = t('id', 'quiz_your_answer', { letter: 'B', text: 'Kecepatan' });
    assert.strictEqual(formattedId, 'Jawaban lu: *B. Kecepatan*');

    // Prompt checks
    assert.ok(getQuizPrompt('en').includes('English'), 'EN quiz prompt must specify English');
    assert.ok(getQuizPrompt('id').includes('Indonesian'), 'ID quiz prompt must specify Indonesian');
    assert.ok(getExplainPrompt('en').includes('🎯 Core Concept'), 'EN explain prompt must use English headings');
    assert.ok(getExplainPrompt('id').includes('🎯 Konsep Inti'), 'ID explain prompt must use Indonesian headings');
    assert.ok(getHintPrompt('en').includes('Nope, the question is locked 🔒'), 'EN hint prompt must use English refusal');
    assert.ok(getHintPrompt('id').includes('Nope, soalnya udah dikunci 🔒'), 'ID hint prompt must use Indonesian refusal');

    console.log('  ✅ Passed Suite 1: i18n Dictionary & Normalization');

    // ----------------------------------------------------
    // Suite 2: ResponseCache Functionality
    // ----------------------------------------------------
    console.log('\nSuite 2: ResponseCache Functionality');

    const cache = new ResponseCache(5, 500); // 5 max entries, 500ms TTL

    const key1 = cache.makeKey('quiz', 'en', 'Photosynthesis process');
    const key2 = cache.makeKey('quiz', 'en', '  photosynthesis process  ');
    assert.strictEqual(key1, key2, 'Keys must normalize whitespace and casing');

    const keyEn = cache.makeKey('explain', 'en', 'Newton 1st Law');
    const keyId = cache.makeKey('explain', 'id', 'Newton 1st Law');
    assert.notStrictEqual(keyEn, keyId, 'Keys must differ by language');

    // Store & Retrieve
    cache.set(key1, { question: 'What is photosynthesis?' });
    const cached = cache.get(key1);
    assert.ok(cached, 'Cache should return entry');
    assert.strictEqual(cached.question, 'What is photosynthesis?');

    const stats = cache.getStats();
    assert.strictEqual(stats.hits, 1, 'Hits should increment on cache hit');
    assert.ok(stats.savedTokensEstimate > 0, 'Saved token estimate should be tracked');

    // Miss
    const missing = cache.get('non_existent_key');
    assert.strictEqual(missing, null);
    assert.strictEqual(cache.getStats().misses, 1);

    // TTL Expiration
    await new Promise((r) => setTimeout(r, 600));
    const expired = cache.get(key1);
    assert.strictEqual(expired, null, 'Expired entry must return null');

    // Eviction test
    const evictCache = new ResponseCache(2, 60000);
    evictCache.set('k1', 'val1');
    evictCache.set('k2', 'val2');
    evictCache.set('k3', 'val3'); // Should evict k1
    assert.strictEqual(evictCache.get('k1'), null, 'Oldest entry should be evicted');
    assert.strictEqual(evictCache.get('k2'), 'val2');
    assert.strictEqual(evictCache.get('k3'), 'val3');

    console.log('  ✅ Passed Suite 2: ResponseCache Functionality');

    // ----------------------------------------------------
    // Suite 3: store.js Language Preferences
    // ----------------------------------------------------
    console.log('\nSuite 3: store.js Language Preferences');

    const userId1 = 90001;
    assert.strictEqual(store.getUserLanguage(userId1), 'en', 'New user must default to English');

    store.setUserLanguage(userId1, 'id');
    assert.strictEqual(store.getUserLanguage(userId1), 'id', 'User language should update to Indonesian');

    store.setUserLanguage(userId1, 'en');
    assert.strictEqual(store.getUserLanguage(userId1), 'en', 'User language should update back to English');

    console.log('  ✅ Passed Suite 3: store.js Language Preferences');

    // ----------------------------------------------------
    // Suite 4: bot.js /language Command & Callbacks
    // ----------------------------------------------------
    console.log('\nSuite 4: bot.js /language Command & Callbacks');

    const { dispatchMessage, dispatchCallback, sentMessages } = createMockBot();
    const testUser = 90002;

    // Default language is en
    assert.strictEqual(store.getUserLanguage(testUser), 'en');

    // /language command
    await dispatchMessage({
      chat: { id: testUser },
      from: { id: testUser },
      text: '/language',
    });

    assert.strictEqual(sentMessages.length, 1);
    const langPrompt = sentMessages[0];
    assert.ok(langPrompt.text.includes('Choose your preferred language') || langPrompt.text.includes('Pilih bahasa'));
    assert.ok(langPrompt.opts && langPrompt.opts.reply_markup);
    const btns = langPrompt.opts.reply_markup.inline_keyboard[0];
    assert.strictEqual(btns[0].callback_data, 'LANG_en');
    assert.strictEqual(btns[1].callback_data, 'LANG_id');

    // Select Indonesian via callback
    sentMessages.length = 0;
    await dispatchCallback({
      id: 'cb_lang_id',
      data: 'LANG_id',
      message: { chat: { id: testUser }, message_id: 1001 },
      from: { id: testUser },
    });

    assert.strictEqual(store.getUserLanguage(testUser), 'id', 'Language should switch to id');
    assert.ok(sentMessages.some((m) => m.text.includes('Bahasa bot diatur ke Bahasa Indonesia!')));

    // Now send /start in Indonesian
    sentMessages.length = 0;
    await dispatchMessage({
      chat: { id: testUser },
      from: { id: testUser },
      text: '/start',
    });
    assert.ok(sentMessages[0].text.includes('Halo! Gua GampangBot'), 'Bot should respond in Indonesian');

    // Switch back to English
    sentMessages.length = 0;
    await dispatchCallback({
      id: 'cb_lang_en',
      data: 'LANG_en',
      message: { chat: { id: testUser }, message_id: 1002 },
      from: { id: testUser },
    });
    assert.strictEqual(store.getUserLanguage(testUser), 'en', 'Language should switch to en');
    assert.ok(sentMessages.some((m) => m.text.includes('Language updated to English!')));

    // Send /start in English
    sentMessages.length = 0;
    await dispatchMessage({
      chat: { id: testUser },
      from: { id: testUser },
      text: '/start',
    });
    assert.ok(sentMessages[0].text.includes('Hi! I am GampangBot'), 'Bot should respond in English');

    console.log('  ✅ Passed Suite 4: bot.js /language Command & Callbacks');

    // ----------------------------------------------------
    // Suite 5: quiz.js Token Caching Integration
    // ----------------------------------------------------
    console.log('\nSuite 5: quiz.js Token Caching Integration');

    responseCache.clear();
    const testMaterial = 'Kecepatan adalah jarak dibagi waktu.';
    const cachedQuizObj = {
      question: 'Apa rumus kecepatan?',
      options: { A: 'v = s / t', B: 'v = s * t', C: 'v = m * a', D: 'v = F / m' },
      correct_answer: 'A',
      explanation: 'Kecepatan didefinisikan sebagai perpindahan per satuan waktu.',
    };

    // Pre-populate responseCache
    const testKey = responseCache.makeKey('quiz', 'id', testMaterial);
    responseCache.set(testKey, cachedQuizObj);

    // generateQuiz should return cached entry without triggering ask()
    const quizResult = await generateQuiz(testMaterial, null, { lang: 'id' });
    assert.deepStrictEqual(quizResult, cachedQuizObj, 'Cached quiz must be returned');

    // buildQuestionText check for en and id
    const renderedEn = buildQuestionText(cachedQuizObj, 'en');
    assert.ok(renderedEn.startsWith('📝 *Quiz!*'));
    assert.ok(renderedEn.includes('Select your answer below 👇'));

    const renderedId = buildQuestionText(cachedQuizObj, 'id');
    assert.ok(renderedId.startsWith('📝 *Kuis!*'));
    assert.ok(renderedId.includes('Pilih jawaban lu di bawah 👇'));

    console.log('  ✅ Passed Suite 5: quiz.js Token Caching Integration');

    console.log('\n=== ALL i18n & Cache Verification Tests Passed Successfully! ===\n');
  } finally {
    restoreStore();
  }
}

runTests().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
