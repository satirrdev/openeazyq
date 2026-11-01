// Tests for quota limits, lazy reset, premium upgrades, and gating.

process.env.AI_API_KEY = process.env.AI_API_KEY || 'test-mock-api-key';
process.env.AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.test-mock.local/v1';
process.env.AI_MODEL_NAME = process.env.AI_MODEL_NAME || 'deepseek-v4.1-flash:free';
process.env.AI_FALLBACK_MODEL_NAME = process.env.AI_FALLBACK_MODEL_NAME || 'mimo-v2.6-flash:free';

const fs = require('fs');
const path = require('path');
const assert = require('assert').strict;
const { performance } = require('perf_hooks');
const OpenAI = require('openai');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const TMP_FILE = path.join(DATA_DIR, 'users.json.tmp');

// Cache existing users.json to restore on teardown.
let originalUsersFileExisted = false;
let originalUsersFileContent = null;

if (fs.existsSync(USERS_FILE)) {
  originalUsersFileExisted = true;
  originalUsersFileContent = fs.readFileSync(USERS_FILE, 'utf8');
}

function restorePersistenceState() {
  try {
    if (fs.existsSync(TMP_FILE)) {
      fs.unlinkSync(TMP_FILE);
    }
  } catch (_) {}

  try {
    if (originalUsersFileExisted && originalUsersFileContent !== null) {
      fs.writeFileSync(USERS_FILE, originalUsersFileContent, 'utf8');
    } else if (fs.existsSync(USERS_FILE)) {
      fs.writeFileSync(USERS_FILE, '{}', 'utf8');
    }
  } catch (_) {}
}

process.on('exit', restorePersistenceState);
process.on('SIGINT', () => {
  restorePersistenceState();
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  restorePersistenceState();
  console.error('Uncaught Exception during test execution:', err);
  process.exit(1);
});

// Intercept OpenAI prototype to mock completions in isolation.
const clientPrototype = (new OpenAI({ apiKey: 'dummy' })).chat.completions.constructor.prototype;
const originalCreate = clientPrototype.create;
let mockCompletionHandler = null;

clientPrototype.create = async function (...args) {
  if (mockCompletionHandler) {
    return mockCompletionHandler(...args);
  }
  return {
    choices: [
      {
        message: {
          content: JSON.stringify({
            question: 'Apa ibukota Indonesia?',
            options: { A: 'Jakarta', B: 'Bandung', C: 'Surabaya', D: 'Medan' },
            correct_answer: 'A',
            explanation: 'Jakarta adalah ibukota Republik Indonesia.',
          }),
        },
      },
    ],
  };
};

let store = require('../store');
let botModule = require('../bot');
const { ERROR_MSG } = require('../quiz');

function reloadModules() {
  delete require.cache[require.resolve('../store')];
  delete require.cache[require.resolve('../bot')];
  store = require('../store');
  botModule = require('../bot');
}

function getState(chatId) {
  return botModule.getState(chatId);
}

function setState(chatId, patch) {
  return botModule.setState(chatId, patch);
}

const registeredSuites = [];
let currentSuiteObj = null;
const testResults = [];

function suite(name, fn) {
  currentSuiteObj = { name, tests: [] };
  registeredSuites.push(currentSuiteObj);
  fn();
}

function test(name, fn) {
  currentSuiteObj.tests.push({ name, fn });
}

function createMockBot() {
  const textHandlers = [];
  const eventHandlers = {};
  const sentMessages = [];
  const answeredCallbacks = [];
  const editedMarkups = [];
  const chatActions = [];

  let sendMessageInterceptor = null;

  const mockBot = {
    onText: (regex, cb) => {
      textHandlers.push({ regex, cb });
    },
    on: (event, cb) => {
      eventHandlers[event] = cb;
    },
    sendMessage: async (chatId, text, opts = {}) => {
      if (sendMessageInterceptor) {
        const intercepted = await sendMessageInterceptor(chatId, text, opts);
        if (intercepted !== undefined) return intercepted;
      }
      const msg = { message_id: 1000 + sentMessages.length, chatId, text, opts };
      sentMessages.push(msg);
      return msg;
    },
    sendChatAction: async (chatId, action) => {
      chatActions.push({ chatId, action });
      return true;
    },
    answerCallbackQuery: async (id, opts = {}) => {
      answeredCallbacks.push({ id, opts });
      return true;
    },
    editMessageReplyMarkup: async (replyMarkup, opts = {}) => {
      editedMarkups.push({ replyMarkup, opts });
      return true;
    },
  };

  botModule.register(mockBot);

  async function dispatchMessage(msg) {
    for (const item of textHandlers) {
      const match = msg.text ? msg.text.match(item.regex) : null;
      if (match) {
        await item.cb(msg, match);
      }
    }
    if (eventHandlers['message']) {
      await eventHandlers['message'](msg);
    }
  }

  async function dispatchCallback(query) {
    if (eventHandlers['callback_query']) {
      await eventHandlers['callback_query'](query);
    }
  }

  function setSendMessageInterceptor(fn) {
    sendMessageInterceptor = fn;
  }

  return {
    mockBot,
    dispatchMessage,
    dispatchCallback,
    setSendMessageInterceptor,
    sentMessages,
    answeredCallbacks,
    editedMarkups,
    chatActions,
  };
}

// Poll until the bot transitions to the expected in-memory state.
async function waitForState(chatId, conditionFn, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const s = getState(chatId);
    if (conditionFn(s)) {
      await new Promise((r) => setTimeout(r, 10)); // Allow microtasks to flush.
      return s;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for state condition in chat ${chatId}. Current state: ${JSON.stringify(getState(chatId))}`);
}

function withMockTime(isoStringOrTimestamp, fn) {
  const RealDate = global.Date;
  const mockTimestamp = typeof isoStringOrTimestamp === 'number'
    ? isoStringOrTimestamp
    : new RealDate(isoStringOrTimestamp).getTime();

  class MockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(mockTimestamp);
      } else {
        super(...args);
      }
    }
    static now() {
      return mockTimestamp;
    }
  }

  global.Date = MockDate;
  try {
    return fn();
  } finally {
    global.Date = RealDate;
  }
}

function registerAllSuites() {
  suite('1. store.js — Free User Quota & Daily Limit Logic', () => {
    test('1.1 New free user initializes with quizCount = 0 and premiumUntil = 0', () => {
      const userId = 'user_init_' + Date.now();
      const user = store.getUser(userId);

      assert.strictEqual(user.quizCount, 0, 'New user quizCount must be 0');
      assert.strictEqual(user.premiumUntil, 0, 'New user premiumUntil must be 0');
      assert.strictEqual(user.lastQuizDate, store.getTodayWIB(), 'New user lastQuizDate must be today WIB');
    });

    test('1.2 canTakeQuiz returns true for new user (attempt 1)', () => {
      const userId = 'user_new_' + Date.now();
      assert.strictEqual(store.canTakeQuiz(userId), true, 'New user must be allowed to take quiz');
    });

    test('1.3 canTakeQuiz returns true for attempts 1 through 5 as usage is recorded', () => {
      const userId = 'user_progression_' + Date.now();

      for (let attempt = 1; attempt <= 5; attempt++) {
        assert.strictEqual(
          store.canTakeQuiz(userId),
          true,
          `canTakeQuiz must be true before attempt ${attempt} (current count: ${attempt - 1})`
        );
        const updated = store.recordQuizUsage(userId);
        assert.strictEqual(updated.quizCount, attempt, `quizCount must increment to ${attempt}`);
      }

      const finalUser = store.getUser(userId);
      assert.strictEqual(finalUser.quizCount, 5, 'quizCount must reach exactly 5 after 5 usages');
    });

    test('1.4 Limit reached: on 6th attempt (quizCount == 5), canTakeQuiz returns false', () => {
      const userId = 'user_limit_5_' + Date.now();

      for (let i = 0; i < 5; i++) {
        store.recordQuizUsage(userId);
      }

      assert.strictEqual(store.getUser(userId).quizCount, 5);
      assert.strictEqual(
        store.canTakeQuiz(userId),
        false,
        'canTakeQuiz must return false when quizCount is 5'
      );
    });

    test('1.5 Beyond limit: quizCount > 5 consistently returns false for canTakeQuiz', () => {
      const userId = 'user_beyond_' + Date.now();
      const u = store.getUser(userId);
      u.quizCount = 6;

      assert.strictEqual(
        store.canTakeQuiz(userId),
        false,
        'canTakeQuiz must return false when quizCount is 6'
      );

      u.quizCount = 10;
      assert.strictEqual(
        store.canTakeQuiz(userId),
        false,
        'canTakeQuiz must return false when quizCount is 10'
      );
    });

    test('1.6 Multi-user quota isolation: User A exhausting quota does not affect User B', () => {
      const userA = 'user_iso_A_' + Date.now();
      const userB = 'user_iso_B_' + Date.now();

      for (let i = 0; i < 5; i++) {
        store.recordQuizUsage(userA);
      }

      assert.strictEqual(store.canTakeQuiz(userA), false, 'User A must be blocked');
      assert.strictEqual(store.canTakeQuiz(userB), true, 'User B must still have full quota');
      assert.strictEqual(store.getUser(userB).quizCount, 0, 'User B quizCount must remain 0');
    });
  });

  suite('2. store.js — Lazy Reset on 00:00 WIB', () => {
    test('2.1 Quota resets to 0 when lastQuizDate is from yesterday / past date', () => {
      const userId = 'user_stale_' + Date.now();
      const user = store.getUser(userId);

      user.quizCount = 5;
      user.lastQuizDate = '2026-01-01';

      const reloadedUser = store.getUser(userId);
      assert.strictEqual(reloadedUser.quizCount, 0, 'quizCount must reset to 0 for a past date');
      assert.strictEqual(
        reloadedUser.lastQuizDate,
        store.getTodayWIB(),
        'lastQuizDate must update to today WIB'
      );
    });

    test('2.2 canTakeQuiz returns true immediately after lazy reset for exhausted user', () => {
      const userId = 'user_lazy_take_' + Date.now();
      const user = store.getUser(userId);
      user.quizCount = 5;
      user.lastQuizDate = '2020-12-31';

      assert.strictEqual(
        store.canTakeQuiz(userId),
        true,
        'canTakeQuiz must return true after lazy reset triggers'
      );
      assert.strictEqual(user.quizCount, 0, 'quizCount must have been reset to 0');
    });

    test('2.3 lastQuizDate updates to current WIB date upon lazy reset', () => {
      const userId = 'user_date_update_' + Date.now();
      const user = store.getUser(userId);
      user.quizCount = 5;
      user.lastQuizDate = '2025-05-15';

      store.getUser(userId);
      assert.strictEqual(user.lastQuizDate, store.getTodayWIB());
    });

    test('2.4 Same-date access does NOT reset quota (count preserved during same day)', () => {
      const userId = 'user_same_day_' + Date.now();
      store.recordQuizUsage(userId);
      store.recordQuizUsage(userId);
      store.recordQuizUsage(userId);

      assert.strictEqual(store.getUser(userId).quizCount, 3);
      assert.strictEqual(store.getUser(userId).quizCount, 3);
      assert.strictEqual(store.canTakeQuiz(userId), true);
    });

    test('2.5 Midnight WIB boundary crossover: 23:59:59 WIB to 00:00:01 WIB triggers lazy reset', () => {
      const userId = 'user_midnight_' + Date.now();

      // WIB is UTC+7: 23:59:59 WIB maps to 16:59:59Z.
      const timeBeforeMidnight = '2026-11-10T16:59:59Z';
      withMockTime(timeBeforeMidnight, () => {
        assert.strictEqual(store.getTodayWIB(), '2026-11-10');
        for (let i = 0; i < 5; i++) {
          store.recordQuizUsage(userId);
        }
        assert.strictEqual(store.getUser(userId).quizCount, 5);
        assert.strictEqual(store.canTakeQuiz(userId), false, 'Must be blocked at 23:59:59 WIB');
      });

      // 00:00:01 WIB maps to 17:00:01Z.
      const timeAfterMidnight = '2026-11-10T17:00:01Z';
      withMockTime(timeAfterMidnight, () => {
        assert.strictEqual(store.getTodayWIB(), '2026-11-11');
        assert.strictEqual(
          store.canTakeQuiz(userId),
          true,
          'Must be allowed at 00:00:01 WIB next day due to lazy reset'
        );
        assert.strictEqual(store.getUser(userId).quizCount, 0, 'Quota must be reset to 0');
        assert.strictEqual(store.getUser(userId).lastQuizDate, '2026-11-11');
      });
    });
  });

  suite('3. store.js — Premium Upgrade & Accumulation', () => {
    test('3.1 upgradeUser(userId, days) sets premiumUntil to Date.now() + days * 86400000', () => {
      const userId = 'user_prem_fresh_' + Date.now();
      const beforeTime = Date.now();
      const upgraded = store.upgradeUser(userId, 7);
      const afterTime = Date.now();

      const expectedDurationMs = 7 * 86400000;
      assert.ok(
        upgraded.premiumUntil >= beforeTime + expectedDurationMs,
        'premiumUntil must be at least now + 7 days'
      );
      assert.ok(
        upgraded.premiumUntil <= afterTime + expectedDurationMs,
        'premiumUntil must be at most now + 7 days'
      );
    });

    test('3.2 Premium users can take quizzes even when quizCount >= 5 (canTakeQuiz is true)', () => {
      const userId = 'user_prem_bypass_' + Date.now();
      const user = store.getUser(userId);
      user.quizCount = 5;

      assert.strictEqual(store.canTakeQuiz(userId), false, 'Non-premium at limit must be false');

      store.upgradeUser(userId, 1);
      assert.strictEqual(
        store.canTakeQuiz(userId),
        true,
        'Premium user must be allowed even when quizCount is 5'
      );

      user.quizCount = 20;
      assert.strictEqual(
        store.canTakeQuiz(userId),
        true,
        'Premium user must be allowed even when quizCount is 20'
      );
    });

    test('3.3 Premium users can take unlimited quizzes without being blocked', () => {
      const userId = 'user_prem_unlimited_' + Date.now();
      store.upgradeUser(userId, 30);

      for (let i = 0; i < 15; i++) {
        assert.strictEqual(store.canTakeQuiz(userId), true);
        store.recordQuizUsage(userId);
      }

      assert.strictEqual(store.getUser(userId).quizCount, 15);
      assert.strictEqual(store.canTakeQuiz(userId), true, 'Must remain true after 15 uses');
    });

    test('3.4 Accumulative premium: upgrading active premium user adds days * 86400000 to existing premiumUntil', () => {
      const userId = 'user_prem_accum_' + Date.now();
      const user = store.getUser(userId);

      const currentExpiry = Date.now() + (10 * 86400000);
      user.premiumUntil = currentExpiry;

      const daysToAdd = 7;
      const expectedNewExpiry = currentExpiry + (daysToAdd * 86400000);

      store.upgradeUser(userId, daysToAdd);
      assert.strictEqual(
        user.premiumUntil,
        expectedNewExpiry,
        'Accumulative upgrade must add days * 86400000 directly to active premiumUntil'
      );
    });

    test('3.5 Expired premium: upgrading user whose premium expired restarts from Date.now()', () => {
      const userId = 'user_prem_expired_' + Date.now();
      const user = store.getUser(userId);

      user.premiumUntil = Date.now() - (5 * 86400000);

      const beforeTime = Date.now();
      store.upgradeUser(userId, 3);
      const afterTime = Date.now();

      const expectedDurationMs = 3 * 86400000;
      assert.ok(
        user.premiumUntil >= beforeTime + expectedDurationMs,
        'Expired upgrade must restart from current time'
      );
      assert.ok(
        user.premiumUntil <= afterTime + expectedDurationMs
      );
    });

    test('3.6 Premium expiration: once premium lapses into the past, user reverts to daily quota limit', () => {
      const userId = 'user_prem_lapse_' + Date.now();
      const user = store.getUser(userId);

      user.quizCount = 5;
      user.premiumUntil = Date.now() - 10000;

      assert.strictEqual(
        store.canTakeQuiz(userId),
        false,
        'User with lapsed premium must be subject to free quota limit'
      );
    });
  });

  suite('4. store.js — Atomic File Persistence & Store Reload', () => {
    test('4.1 recordQuizUsage and upgradeUser persist data to data/users.json atomically', () => {
      const userId = 'user_persist_atomic_' + Date.now();
      store.upgradeUser(userId, 14);
      store.recordQuizUsage(userId);

      assert.ok(fs.existsSync(USERS_FILE), 'users.json must exist on disk');

      const fileRaw = fs.readFileSync(USERS_FILE, 'utf8');
      const fileParsed = JSON.parse(fileRaw);

      assert.ok(fileParsed[userId], 'Persisted file must contain the user record');
      assert.strictEqual(fileParsed[userId].quizCount, 1);
      assert.ok(fileParsed[userId].premiumUntil > Date.now());
    });

    test('4.2 Atomic rename guarantees data/users.json.tmp does not linger', () => {
      assert.strictEqual(
        fs.existsSync(TMP_FILE),
        false,
        'users.json.tmp must not exist after atomic save completes'
      );
    });

    test('4.3 Reloading store module from disk restores exact user records and premium states', () => {
      const userId = 'user_persist_reload_' + Date.now();
      store.upgradeUser(userId, 5);
      store.recordQuizUsage(userId);
      store.recordQuizUsage(userId);

      const beforeUser = store.getUser(userId);

      reloadModules();

      const reloadedUser = store.getUser(userId);
      assert.strictEqual(reloadedUser.quizCount, 2, 'Reloaded quizCount must match persisted value');
      assert.strictEqual(
        reloadedUser.premiumUntil,
        beforeUser.premiumUntil,
        'Reloaded premiumUntil must match persisted value'
      );
      assert.strictEqual(
        reloadedUser.lastQuizDate,
        beforeUser.lastQuizDate,
        'Reloaded lastQuizDate must match persisted value'
      );
    });

    test('4.4 Corrupted or missing users.json fails gracefully to empty store without crashing', () => {
      const originalConsoleError = console.error;
      console.error = () => {}; // Suppress expected syntax error log.

      try {
        fs.writeFileSync(USERS_FILE, 'INVALID_JSON_CORRUPTED{{{', 'utf8');

        reloadModules();

        const testUser = store.getUser('resilient_user_1');
        assert.ok(testUser, 'Should initialize a new user record on corrupted store');
        assert.strictEqual(testUser.quizCount, 0);
      } finally {
        console.error = originalConsoleError;
        fs.writeFileSync(USERS_FILE, '{}', 'utf8');
        reloadModules();
      }
    });
  });

  suite('5. bot.js — /iduser & /upgrade Commands', () => {
    test('5.1 /iduser outputs sender user ID formatted in monospace backticks (`<userId>`)', async () => {
      const { dispatchMessage, sentMessages } = createMockBot();
      const callerId = 78912345;
      const chatId = 78912345;

      await dispatchMessage({
        chat: { id: chatId },
        from: { id: callerId },
        text: '/iduser',
      });

      assert.strictEqual(sentMessages.length, 1, 'Should send exactly 1 response message');
      const response = sentMessages[0];
      assert.strictEqual(response.chatId, chatId);
      assert.ok(
        response.text.includes(`\`${callerId}\``),
        `Message must contain caller ID in backticks: \`${callerId}\`. Received: "${response.text}"`
      );
    });

    test('5.2 /iduser directs user to contact owner @satirvx for upgrade', async () => {
      const { dispatchMessage, sentMessages } = createMockBot();
      await dispatchMessage({
        chat: { id: 111 },
        from: { id: 111 },
        text: '/iduser',
      });

      const response = sentMessages[0];
      assert.ok(response.text.includes('@satirvx'), 'Message must mention @satirvx');
      assert.strictEqual(response.opts.parse_mode, 'Markdown', 'Must use Markdown parse_mode');
    });

    test('5.3 /upgrade rejects non-admin users with exact security error', async () => {
      const originalAdmin = process.env.ADMIN_ID;
      process.env.ADMIN_ID = '99999999';

      try {
        const { dispatchMessage, sentMessages } = createMockBot();
        const nonAdminId = 12345678;

        await dispatchMessage({
          chat: { id: nonAdminId },
          from: { id: nonAdminId },
          text: '/upgrade 88888888 7',
        });

        assert.strictEqual(sentMessages.length, 1);
        assert.strictEqual(
          sentMessages[0].text,
          'Akses ditolak. Perintah ini cuma buat admin.',
          'Must reject non-admin with exact message'
        );

        assert.strictEqual(store.getUser('88888888').premiumUntil, 0);
      } finally {
        process.env.ADMIN_ID = originalAdmin;
      }
    });

    test('5.4 /upgrade rejects requests when ADMIN_ID is unset in environment', async () => {
      const originalAdmin = process.env.ADMIN_ID;
      delete process.env.ADMIN_ID;

      try {
        const { dispatchMessage, sentMessages } = createMockBot();

        await dispatchMessage({
          chat: { id: 999 },
          from: { id: 999 },
          text: '/upgrade 888 7',
        });

        assert.strictEqual(sentMessages.length, 1);
        assert.strictEqual(sentMessages[0].text, 'Akses ditolak. Perintah ini cuma buat admin.');
      } finally {
        process.env.ADMIN_ID = originalAdmin;
      }
    });

    test('5.5 /upgrade rejects admin requests with missing arguments (shows usage instructions)', async () => {
      const originalAdmin = process.env.ADMIN_ID;
      process.env.ADMIN_ID = '99999';

      try {
        const { dispatchMessage, sentMessages } = createMockBot();

        await dispatchMessage({
          chat: { id: 99999 },
          from: { id: 99999 },
          text: '/upgrade',
        });

        assert.strictEqual(sentMessages.length, 1);
        assert.ok(
          sentMessages[0].text.includes('Format salah! Gunakan: `/upgrade <userId> <days>`'),
          `Expected format error, got: "${sentMessages[0].text}"`
        );
      } finally {
        process.env.ADMIN_ID = originalAdmin;
      }
    });

    test('5.6 /upgrade rejects admin requests with invalid days (NaN, 0, negative)', async () => {
      const originalAdmin = process.env.ADMIN_ID;
      process.env.ADMIN_ID = '99999';

      try {
        const { dispatchMessage, sentMessages } = createMockBot();

        const invalidCommands = [
          '/upgrade 12345 abc',
          '/upgrade 12345 0',
          '/upgrade 12345 -7',
        ];

        for (const cmd of invalidCommands) {
          sentMessages.length = 0;
          await dispatchMessage({
            chat: { id: 99999 },
            from: { id: 99999 },
            text: cmd,
          });

          assert.strictEqual(sentMessages.length, 1);
          assert.ok(
            sentMessages[0].text.includes('Format salah! Gunakan: `/upgrade <userId> <days>`'),
            `Command "${cmd}" should fail with format error`
          );
        }
      } finally {
        process.env.ADMIN_ID = originalAdmin;
      }
    });

    test('5.7 /upgrade by valid admin upgrades target user in store and records duration', async () => {
      const originalAdmin = process.env.ADMIN_ID;
      const adminId = 99999;
      const targetUserId = 'target_user_777';
      process.env.ADMIN_ID = String(adminId);

      try {
        const { dispatchMessage } = createMockBot();

        await dispatchMessage({
          chat: { id: adminId },
          from: { id: adminId },
          text: `/upgrade ${targetUserId} 7`,
        });

        const targetUser = store.getUser(targetUserId);
        assert.ok(
          targetUser.premiumUntil > Date.now(),
          'Target user must have premiumUntil set in the future'
        );
      } finally {
        process.env.ADMIN_ID = originalAdmin;
      }
    });

    test('5.8 /upgrade sends confirmation to admin with target ID, days, and Jakarta WIB expiry date', async () => {
      const originalAdmin = process.env.ADMIN_ID;
      const adminId = 99999;
      const targetUserId = 'target_user_888';
      process.env.ADMIN_ID = String(adminId);

      try {
        const { dispatchMessage, sentMessages } = createMockBot();

        await dispatchMessage({
          chat: { id: adminId },
          from: { id: adminId },
          text: `/upgrade ${targetUserId} 14`,
        });

        const adminMsg = sentMessages.find((m) => m.chatId === adminId);
        assert.ok(adminMsg, 'Admin must receive confirmation message');
        assert.ok(adminMsg.text.includes(`✅ Berhasil upgrade user \`${targetUserId}\` selama 14 hari.`));
        assert.ok(adminMsg.text.includes('Kadaluarsa:'));
        assert.ok(adminMsg.text.includes('WIB'));
      } finally {
        process.env.ADMIN_ID = originalAdmin;
      }
    });

    test('5.9 /upgrade sends celebratory notification message to target user', async () => {
      const originalAdmin = process.env.ADMIN_ID;
      const adminId = 99999;
      const targetUserId = 'target_user_999';
      process.env.ADMIN_ID = String(adminId);

      try {
        const { dispatchMessage, sentMessages } = createMockBot();

        await dispatchMessage({
          chat: { id: adminId },
          from: { id: adminId },
          text: `/upgrade ${targetUserId} 30`,
        });

        const userMsg = sentMessages.find((m) => String(m.chatId) === targetUserId);
        assert.ok(userMsg, 'Target user must receive direct notification');
        assert.ok(userMsg.text.includes('🎉 Akun kamu sudah di-upgrade ke Premium selama 30 hari!'));
        assert.ok(userMsg.text.includes('@satirvx'));
      } finally {
        process.env.ADMIN_ID = originalAdmin;
      }
    });

    test('5.10 /upgrade handles target user notification delivery failure gracefully', async () => {
      const originalAdmin = process.env.ADMIN_ID;
      const adminId = 99999;
      const targetUserId = 'blocked_bot_user_111';
      process.env.ADMIN_ID = String(adminId);

      try {
        const { dispatchMessage, sentMessages, setSendMessageInterceptor } = createMockBot();

        // Simulate delivery rejection by target chat.
        setSendMessageInterceptor(async (chatId, text, opts) => {
          if (String(chatId) === targetUserId) {
            throw new Error('ETELEGRAM: 403 Forbidden: bot was blocked by the user');
          }
        });

        await dispatchMessage({
          chat: { id: adminId },
          from: { id: adminId },
          text: `/upgrade ${targetUserId} 7`,
        });

        assert.ok(store.getUser(targetUserId).premiumUntil > Date.now());

        const warningMsg = sentMessages.find((m) => m.text.includes('⚠️ Gagal kirim notifikasi ke user'));
        assert.ok(warningMsg, 'Admin should be notified of notification failure');
      } finally {
        process.env.ADMIN_ID = originalAdmin;
      }
    });
  });

  suite('6. bot.js — Quota Gating, Delivery Accounting, & Unlimited Features', () => {
    const EXACT_QUOTA_EXHAUSTED_MSG =
      'Limit Quiz kamu sudah habis! Mau upgrade limit untuk persiapan ujian besok? Cuma 10.000 buat 7 Hari, Chat owner @satirvx';

    test('6.1 CHOICE_QUIZ blocks exhausted free user and sends exact upsell message', async () => {
      const { dispatchCallback, sentMessages } = createMockBot();
      const chatId = 6001;

      for (let i = 0; i < 5; i++) {
        store.recordQuizUsage(chatId);
      }
      assert.strictEqual(store.canTakeQuiz(chatId), false);

      setState(chatId, { state: 'IDLE', material: 'Materi Biologi SMA' });

      await dispatchCallback({
        id: 'cb_blocked_1',
        data: 'CHOICE_QUIZ',
        message: { chat: { id: chatId }, message_id: 888 },
      });

      const blockedMsg = sentMessages.find((m) => m.chatId === chatId && m.text === EXACT_QUOTA_EXHAUSTED_MSG);
      assert.ok(
        blockedMsg,
        `Expected exact block message "${EXACT_QUOTA_EXHAUSTED_MSG}", sent: ${JSON.stringify(sentMessages.map((m) => m.text))}`
      );

      const s = getState(chatId);
      assert.notStrictEqual(s.state, 'QUIZ_ACTIVE');
      assert.notStrictEqual(s.state, 'AWAITING_ANSWER');
    });

    test('6.2 CHOICE_QUIZ removes reply markup and answers callback query when blocked', async () => {
      const { dispatchCallback, answeredCallbacks, editedMarkups } = createMockBot();
      const chatId = 6002;

      for (let i = 0; i < 5; i++) {
        store.recordQuizUsage(chatId);
      }

      setState(chatId, { state: 'IDLE', material: 'Materi Fisika' });

      await dispatchCallback({
        id: 'cb_query_blocked_cleanup',
        data: 'CHOICE_QUIZ',
        message: { chat: { id: chatId }, message_id: 999 },
      });

      assert.ok(
        answeredCallbacks.some((cb) => cb.id === 'cb_query_blocked_cleanup'),
        'Callback query must be answered'
      );
      assert.ok(
        editedMarkups.some((m) => m.opts && m.opts.message_id === 999 && m.replyMarkup === undefined),
        'Message reply markup must be cleared'
      );
    });

    test('6.3 CHOICE_QUIZ allows active premium user to generate quiz even if quizCount >= 5', async () => {
      const { dispatchCallback } = createMockBot();
      const chatId = 6003;

      for (let i = 0; i < 5; i++) {
        store.recordQuizUsage(chatId);
      }
      store.upgradeUser(chatId, 7);

      assert.strictEqual(store.canTakeQuiz(chatId), true);
      setState(chatId, { state: 'IDLE', material: 'Materi Kimia Organik' });

      await dispatchCallback({
        id: 'cb_prem_allowed',
        data: 'CHOICE_QUIZ',
        message: { chat: { id: chatId }, message_id: 101 },
      });

      const finalState = await waitForState(chatId, (s) => s.state === 'AWAITING_ANSWER');
      assert.strictEqual(finalState.state, 'AWAITING_ANSWER');
      assert.ok(finalState.quiz, 'Quiz should be generated for premium user');
    });

    test('6.4 handleQuiz only increments quota AFTER successful delivery of quiz question', async () => {
      const { dispatchCallback, sentMessages } = createMockBot();
      const chatId = 6004;

      assert.strictEqual(store.getUser(chatId).quizCount, 0, 'Initial quizCount must be 0');

      setState(chatId, { state: 'IDLE', material: 'Materi Sejarah Indonesia' });

      await dispatchCallback({
        id: 'cb_quiz_success',
        data: 'CHOICE_QUIZ',
        message: { chat: { id: chatId }, message_id: 102 },
      });

      await waitForState(chatId, (s) => s.state === 'AWAITING_ANSWER');

      assert.strictEqual(
        store.getUser(chatId).quizCount,
        1,
        'quizCount must increment to 1 only after successful generation and delivery'
      );

      const questionMsg = sentMessages.find((m) => m.chatId === chatId && m.text.includes('📝 *Kuis!*'));
      assert.ok(questionMsg, 'Question message must have been delivered');
    });

    test('6.5 handleQuiz does NOT increment quota if quiz generation fails (LLM error)', async () => {
      const originalConsoleError = console.error;
      const originalConsoleWarn = console.warn;
      console.error = () => {}; // Suppress expected LLM failure logs.
      console.warn = () => {};

      try {
        const { dispatchCallback, sentMessages } = createMockBot();
        const chatId = 6005;

        assert.strictEqual(store.getUser(chatId).quizCount, 0);
        setState(chatId, { state: 'IDLE', material: 'Materi Aljabar' });

        mockCompletionHandler = async () => {
          throw new Error('500 Service Unavailable from LLM');
        };

        await dispatchCallback({
          id: 'cb_quiz_fail_llm',
          data: 'CHOICE_QUIZ',
          message: { chat: { id: chatId }, message_id: 103 },
        });

        await waitForState(chatId, (s) => s.state === 'IDLE' && s.quiz === null);

        assert.strictEqual(
          store.getUser(chatId).quizCount,
          0,
          'quizCount must NOT be consumed if quiz generation failed'
        );

        const errorMsg = sentMessages.find((m) => m.chatId === chatId && m.text === ERROR_MSG);
        assert.ok(errorMsg, 'User should receive AI error message');
      } finally {
        mockCompletionHandler = null;
        console.error = originalConsoleError;
        console.warn = originalConsoleWarn;
      }
    });

    test('6.6 handleQuiz does NOT increment quota if message delivery fails (sendSmart error)', async () => {
      const originalConsoleError = console.error;
      console.error = () => {}; // Suppress expected delivery error log.

      try {
        const { dispatchCallback, setSendMessageInterceptor } = createMockBot();
        const chatId = 6006;

        assert.strictEqual(store.getUser(chatId).quizCount, 0);
        setState(chatId, { state: 'IDLE', material: 'Materi Geografi' });

        // Allow initial acknowledgment but fail when sending the quiz question.
        setSendMessageInterceptor(async (targetChatId, text, opts) => {
          if (text.includes('📝 *Kuis!*') || opts.reply_markup) {
            throw new Error('Telegram network drop during delivery');
          }
        });

        await dispatchCallback({
          id: 'cb_quiz_fail_send',
          data: 'CHOICE_QUIZ',
          message: { chat: { id: chatId }, message_id: 104 },
        });

        await waitForState(chatId, (s) => s.state === 'IDLE' && s.quiz === null);

        assert.strictEqual(
          store.getUser(chatId).quizCount,
          0,
          'quizCount must NOT be consumed if question delivery threw an error'
        );
      } finally {
        console.error = originalConsoleError;
      }
    });

    test('6.7 CHOICE_EXPLAIN is unlimited: succeeds and never checks or consumes quota', async () => {
      const { dispatchCallback, sentMessages } = createMockBot();
      const chatId = 6007;

      for (let i = 0; i < 5; i++) {
        store.recordQuizUsage(chatId);
      }
      assert.strictEqual(store.canTakeQuiz(chatId), false);
      assert.strictEqual(store.getUser(chatId).quizCount, 5);

      mockCompletionHandler = async () => ({
        choices: [{ message: { content: 'Ini penjelasan konsep fotosintesis tanpa batas!' } }],
      });

      setState(chatId, { state: 'IDLE', material: 'Fotosintesis pada daun' });

      await dispatchCallback({
        id: 'cb_explain_unlimited',
        data: 'CHOICE_EXPLAIN',
        message: { chat: { id: chatId }, message_id: 105 },
      });

      await waitForState(chatId, (s) => s.state === 'IDLE');

      assert.strictEqual(
        store.getUser(chatId).quizCount,
        5,
        'quizCount must remain 5 (explanations do not consume quota)'
      );

      const blockNotice = sentMessages.find((m) => m.text === EXACT_QUOTA_EXHAUSTED_MSG);
      assert.strictEqual(blockNotice, undefined, 'Must not send quota exhausted block message');

      const explainMsg = sentMessages.find((m) => m.chatId === chatId && m.text.includes('Ini penjelasan konsep fotosintesis'));
      assert.ok(explainMsg, 'Explanation should be delivered successfully');

      mockCompletionHandler = null;
    });
  });
}

async function runAllTests() {
  registerAllSuites();

  for (const s of registeredSuites) {
    for (const t of s.tests) {
      const start = performance.now();
      const testRecord = { suite: s.name, name: t.name, status: 'PENDING', durationMs: 0, error: null };
      try {
        await t.fn();
        testRecord.status = 'PASS';
      } catch (err) {
        testRecord.status = 'FAIL';
        testRecord.error = err;
      } finally {
        testRecord.durationMs = Number((performance.now() - start).toFixed(2));
        testResults.push(testRecord);
      }
    }
  }
}

(async () => {
  const overallStart = performance.now();
  try {
    await runAllTests();
  } finally {
    clientPrototype.create = originalCreate;
    restorePersistenceState();
  }
  const overallDuration = (performance.now() - overallStart).toFixed(2);

  const suites = [...new Set(testResults.map((r) => r.suite))];
  const passed = testResults.filter((r) => r.status === 'PASS').length;
  const failed = testResults.filter((r) => r.status === 'FAIL').length;
  const total = testResults.length;

  console.log('='.repeat(80));
  console.log(' GAMPANGBOT AUTOMATED TEST SUITE: QUOTA LIMITS, LAZY RESET & UPGRADES');
  console.log('='.repeat(80));
  console.log(`Executed: ${new Date().toISOString()}`);
  console.log(`Node.js:  ${process.version}`);
  console.log(`Platform: ${process.platform}`);
  console.log('-'.repeat(80));

  for (const sName of suites) {
    console.log(`\n📁 SUITE: ${sName}`);
    const suiteTests = testResults.filter((r) => r.suite === sName);
    for (const t of suiteTests) {
      const badge = t.status === 'PASS' ? '✅ PASS' : '❌ FAIL';
      console.log(`   ${badge} [${t.durationMs}ms] ${t.name}`);
      if (t.error) {
        console.error(`          Error: ${t.error.message}`);
        if (t.error.stack) {
          const stackLine = t.error.stack.split('\n')[1] || '';
          console.error(`          ${stackLine.trim()}`);
        }
      }
    }
  }

  console.log('\n' + '='.repeat(80));
  console.log(' EXECUTION SUMMARY & METRICS');
  console.log('='.repeat(80));
  console.log(` Total Tests:    ${total}`);
  console.log(` Passed:         ${passed} (100% target: ${passed === total ? 'MET' : 'UNMET'})`);
  console.log(` Failed:         ${failed}`);
  console.log(` Success Rate:   ${((passed / total) * 100).toFixed(1)}%`);
  console.log(` Total Duration: ${overallDuration}ms`);
  console.log('='.repeat(80));

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
})();
