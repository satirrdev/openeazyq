/**
 * Automated Test Suite for GampangBot: Dynamic Routing, Question Safety, Timeout Fix, and JSON Resilience
 * Path: tests/test_routing_timeout.js
 *
 * Covers:
 * 1. classifyComplexity(text) in quiz.js:
 *    - 'light' for conceptual non-STEM questions, short definitions, edge cases
 *    - 'heavy' for math symbols, STEM keywords, code blocks, or text > 500 chars
 * 2. Question delivery safety:
 *    - buildQuestionText(quiz) NEVER leaks quiz.correct_answer or quiz.explanation
 * 3. Dynamic Model Routing in quiz.js and bot.js:
 *    - Light questions route to Mimo v2.6 as primary model
 *    - Heavy questions route to DeepSeek as primary model
 *    - bot.js handleExplain and handleHint routing & token budgets
 * 4. Fallback execution & timeout fix in llm.js:
 *    - Primary model throws error or times out -> ask() executes fallbackModel
 *    - Both fail -> clean error thrown
 *    - AbortController and timeout forwarded to OpenAI completion call
 * 5. extractJson resilience in llm.js:
 *    - Handles trailing commas, markdown fences (with/without lang tag), leading text, trailing text
 * 6. End-to-End Quiz Generation Fallback & Robustness
 */

// Ensure environment variables are present before requiring dependencies
process.env.AI_API_KEY = process.env.AI_API_KEY || 'test-mock-api-key';
process.env.AI_BASE_URL = process.env.AI_BASE_URL || 'https://api.test-mock.local/v1';
process.env.AI_MODEL_NAME = process.env.AI_MODEL_NAME || 'deepseek-v4.1-flash:free';
process.env.AI_FALLBACK_MODEL_NAME = process.env.AI_FALLBACK_MODEL_NAME || 'mimo-v2.6-flash:free';

const assert = require('assert').strict;
const { performance } = require('perf_hooks');
const OpenAI = require('openai');

// Intercept OpenAI prototype to control completions in isolation
const clientPrototype = (new OpenAI({ apiKey: 'dummy' })).chat.completions.constructor.prototype;
const originalCreate = clientPrototype.create;

// Import application modules under test
const {
  ask,
  extractJson,
  stripFences,
  ERROR_MSG,
  MODEL_DEEPSEEK,
  MODEL_MIMO,
  PRIMARY_MODEL,
  FALLBACK_MODEL,
} = require('../llm');

const {
  classifyComplexity,
  buildQuestionText,
  generateQuiz,
  buildQuizKeyboard,
  EXPLAIN_SYSTEM_PROMPT,
  HINT_SYSTEM_PROMPT,
} = require('../quiz');

const {
  register: registerBot,
  getState,
  setState,
  downloadTelegramImageAsBase64,
  sendSmart,
  splitIntoChunks,
} = require('../bot');

// Test framework state
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

// Mock handler to intercept OpenAI completions
let mockHandler = null;
clientPrototype.create = async function (...args) {
  if (mockHandler) {
    return mockHandler(...args);
  }
  return { choices: [{ message: { content: '{}' } }] };
};

// Helper: Setup mock Telegram bot for testing bot.js handlers
function createMockBot() {
  const handlers = {};
  const sentMessages = [];
  const answeredCallbacks = [];
  const editedMarkups = [];

  const mockBot = {
    onText: (pattern, cb) => {
      handlers['onText_' + pattern] = cb;
    },
    on: (event, cb) => {
      handlers[event] = cb;
    },
    sendMessage: async (chatId, text, opts) => {
      const msg = { message_id: 1000 + sentMessages.length, chatId, text, opts };
      sentMessages.push(msg);
      return msg;
    },
    sendChatAction: async (chatId, action) => {},
    answerCallbackQuery: async (id, opts) => {
      answeredCallbacks.push({ id, opts });
      return true;
    },
    editMessageReplyMarkup: async (replyMarkup, opts) => {
      editedMarkups.push({ replyMarkup, opts });
      return true;
    },
    getFileLink: async (fileId) => `https://api.telegram.org/file/bot-mock/${fileId}`,
    setMyCommands: async () => true,
  };

  registerBot(mockBot);

  return { mockBot, handlers, sentMessages, answeredCallbacks, editedMarkups };
}

// ==========================================
// TEST SUITE DEFINITIONS
// ==========================================

function registerAllSuites() {

  // ----------------------------------------------------
  // SUITE 1: Question Complexity Classification
  // ----------------------------------------------------
  suite('1. Question Complexity Classification (classifyComplexity)', () => {
    test('1.1 Simple conceptual non-STEM topics classified as "light"', () => {
      const lightSamples = [
        'Ibukota Indonesia adalah Jakarta.',
        'Jelaskan pengertian fotosintesis pada daun secara umum.',
        'Siapakah bapak proklamator kemerdekaan Republik Indonesia?',
        'Siklus air hujan dan proses evaporasi air laut di atmosfer bumi.',
        'Pengertian respirasi aerob dan anaerob pada makhluk hidup.',
        'Ciri-ciri kingdom animalia dan plantae dalam biologi dasar.',
        'Perbedaan candi Hindu dan candi Buddha di Jawa Tengah.',
      ];

      for (const sample of lightSamples) {
        assert.strictEqual(
          classifyComplexity(sample),
          'light',
          `Expected "${sample}" to be classified as light`
        );
      }
    });

    test('1.2 Math symbols & LaTeX expressions trigger "heavy"', () => {
      const mathSamples = [
        'Hitunglah \\frac{3}{4} + \\sqrt{16}',
        'Rumus integral ∫ f(x) dx dari 0 sampai 1',
        'Penjumlahan deret ∑ i^2 untuk i=1..n',
        'Turunan parsial ∂z/∂x pada bidang multivariat',
        'Berapa nilai x jika x^2 + 2x - 3 = 0?',
        'Simbol ketidaksamaan: a ≤ b dan x ≥ y',
        'Operasi matriks dan determinan det(A)',
        'Limit fungsi lim x->0 (sin(x)/x)',
        'Nilai dari cos(π/2) dan tan(0)',
        'Perkalian silang vektor A × B',
        'Nilai turunan d/dx (x^3 + 2x)',
        'Notasi superskrip x^2 dan subskrip a_{i}',
        'Toleransi error ± 0.05 dan ketidaksamaan x ≠ 0',
      ];

      for (const sample of mathSamples) {
        assert.strictEqual(
          classifyComplexity(sample),
          'heavy',
          `Expected math expression "${sample}" to trigger heavy`
        );
      }
    });

    test('1.3 STEM keywords trigger "heavy" regardless of casing', () => {
      const stemKeywords = [
        'integral', 'turunan', 'kalkulus', 'diferensial', 'matriks',
        'vektor', 'trigonometri', 'aljabar', 'polinomial', 'eigen',
        'termodinamika', 'kinematika', 'stokiometri', 'stoikiometri',
        'algoritma', 'kompleksitas', 'pseudocode', 'pembuktian',
        'olimpiade', 'utbk',
      ];

      for (const kw of stemKeywords) {
        const textLower = `Berikut materi tentang ${kw} dasar untuk SMA.`;
        assert.strictEqual(
          classifyComplexity(textLower),
          'heavy',
          `Expected STEM keyword "${kw}" in lowercase to trigger heavy`
        );

        const textUpper = `SOAL LATIHAN ${kw.toUpperCase()} TINGKAT LANJUT`;
        assert.strictEqual(
          classifyComplexity(textUpper),
          'heavy',
          `Expected STEM keyword "${kw}" in uppercase to trigger heavy`
        );
      }
    });

    test('1.4 Code blocks and programming keywords trigger "heavy"', () => {
      const codeSamples = [
        '```python\nprint("Hello World")\n```',
        '```javascript\nconst a = 10;\n```',
        '```\nSELECT * FROM users;\n```',
        'function hitungGaji(jam, tarif) { return jam * tarif; }',
        'def solve(arr):\n    return sorted(arr)',
        'class BinaryTreeNode {\n    constructor(val) {}\n}',
      ];

      for (const sample of codeSamples) {
        assert.strictEqual(
          classifyComplexity(sample),
          'heavy',
          `Expected code sample to trigger heavy: ${sample.slice(0, 30)}`
        );
      }
    });

    test('1.5 Character length threshold: exactly 500 chars is light, 501 chars is heavy', () => {
      const text500 = 'A'.repeat(500);
      assert.strictEqual(text500.length, 500);
      assert.strictEqual(classifyComplexity(text500), 'light');

      const text501 = 'A'.repeat(501);
      assert.strictEqual(text501.length, 501);
      assert.strictEqual(classifyComplexity(text501), 'heavy');

      // Whitespace padding should be trimmed before length check
      const textPadded = '  ' + 'B'.repeat(500) + '  ';
      assert.strictEqual(classifyComplexity(textPadded), 'light', 'Trimmed 500 chars must remain light');
    });

    test('1.6 Falsy, non-string, and empty inputs safely return "light"', () => {
      assert.strictEqual(classifyComplexity(''), 'light');
      assert.strictEqual(classifyComplexity('   '), 'light');
      assert.strictEqual(classifyComplexity(null), 'light');
      assert.strictEqual(classifyComplexity(undefined), 'light');
      assert.strictEqual(classifyComplexity(12345), 'light');
      assert.strictEqual(classifyComplexity({ text: 'obj' }), 'light');
      assert.strictEqual(classifyComplexity(['kalkulus']), 'light');
    });
  });

  // ----------------------------------------------------
  // SUITE 2: Question Delivery Safety (buildQuestionText)
  // ----------------------------------------------------
  suite('2. Question Delivery Safety (buildQuestionText)', () => {
    const mockQuiz = {
      question: 'Berapakah hasil dari 2 + 2 × 2?',
      options: {
        A: '4',
        B: '6',
        C: '8',
        D: '10',
      },
      correct_answer: 'B',
      explanation: 'Sesuai aturan kabataku (urutan operasi), perkalian dihitung terlebih dahulu: 2 + 4 = 6.',
    };

    test('2.1 buildQuestionText NEVER contains or leaks quiz.explanation', () => {
      const rendered = buildQuestionText(mockQuiz);

      // Must not contain full explanation
      assert.strictEqual(
        rendered.includes(mockQuiz.explanation),
        false,
        'buildQuestionText must never contain quiz.explanation'
      );

      // Must not contain distinctive tokens from explanation
      assert.strictEqual(rendered.toLowerCase().includes('kabataku'), false);
      assert.strictEqual(rendered.toLowerCase().includes('urutan operasi'), false);
      assert.strictEqual(rendered.toLowerCase().includes('terlebih dahulu'), false);
    });

    test('2.2 buildQuestionText NEVER leaks quiz.correct_answer or answer indicator', () => {
      const rendered = buildQuestionText(mockQuiz);

      // Must not state the answer explicitly
      assert.strictEqual(/jawaban\s*(benar|nya|:)/i.test(rendered), false);
      assert.strictEqual(/kunci\s*(jawaban)?/i.test(rendered), false);
      assert.strictEqual(/correct/i.test(rendered), false);

      // Must not include selection indicator or checkmark
      assert.strictEqual(rendered.includes('✅'), false, 'Question must not contain checkmark ✅');
      assert.strictEqual(rendered.includes('✔'), false);
      assert.strictEqual(rendered.includes('B (jawaban)'), false);
      assert.strictEqual(rendered.includes('(B)'), false);
    });

    test('2.3 buildQuestionText contains only prompt, options A-D, and selection instructions', () => {
      const rendered = buildQuestionText(mockQuiz);

      assert.ok(rendered.startsWith('📝 *Kuis!*'));
      assert.ok(rendered.includes(mockQuiz.question));
      assert.ok(rendered.includes('*A.* 4'));
      assert.ok(rendered.includes('*B.* 6'));
      assert.ok(rendered.includes('*C.* 8'));
      assert.ok(rendered.includes('*D.* 10'));
      assert.ok(rendered.includes('Pilih jawaban lu di bawah 👇'));
    });

    test('2.4 Privacy verified with secret canary token in explanation', () => {
      const canarySecret = 'SECRET_CANARY_TOKEN_XYZ_98765_DO_NOT_LEAK';
      const secretQuiz = {
        question: 'Dimana letak Candi Borobudur?',
        options: {
          A: 'Magelang',
          B: 'Sleman',
          C: 'Bantul',
          D: 'Klaten',
        },
        correct_answer: 'A',
        explanation: `Terletak di Magelang, Jawa Tengah. ${canarySecret}`,
      };

      const rendered = buildQuestionText(secretQuiz);
      assert.strictEqual(
        rendered.includes(canarySecret),
        false,
        'Canary token from explanation must never leak into rendered question'
      );
    });

    test('2.5 All answer positions (A, B, C, D) render uniformly with zero bias', () => {
      for (const targetAnswer of ['A', 'B', 'C', 'D']) {
        const quizObj = {
          question: `Sample question targeting answer ${targetAnswer}`,
          options: { A: 'Alpha', B: 'Beta', C: 'Gamma', D: 'Delta' },
          correct_answer: targetAnswer,
          explanation: `Confidential reasoning for ${targetAnswer} being right.`,
        };
        const rendered = buildQuestionText(quizObj);

        // Ensure explanation never appears
        assert.strictEqual(rendered.includes(`Confidential reasoning for ${targetAnswer}`), false);

        // Ensure the correct answer letter is NOT highlighted or decorated differently
        assert.ok(rendered.includes('*A.* Alpha'));
        assert.ok(rendered.includes('*B.* Beta'));
        assert.ok(rendered.includes('*C.* Gamma'));
        assert.ok(rendered.includes('*D.* Delta'));
      }
    });
  });

  // ----------------------------------------------------
  // SUITE 3: Dynamic Model Routing in quiz.js and bot.js
  // ----------------------------------------------------
  suite('3. Dynamic Model Routing in quiz.js and bot.js', () => {
    // 3.1 Light material in quiz.js routes to DeepSeek
    test('3.1 quiz.js: Light material routes to DeepSeek (primary) with 30s timeout & 450 tokens', async () => {
      let capturedBody = null;
      let capturedOpts = null;

      mockHandler = async (body, opts) => {
        capturedBody = body;
        capturedOpts = opts;
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  question: 'Apa ibukota Indonesia?',
                  options: { A: 'Jakarta', B: 'Bandung', C: 'Surabaya', D: 'Medan' },
                  correct_answer: 'A',
                  explanation: 'Jakarta adalah ibukota negara Indonesia.',
                }),
              },
            },
          ],
        };
      };

      const lightMaterial = 'Ibukota negara Indonesia adalah Jakarta.';
      const quiz = await generateQuiz(lightMaterial);

      assert.ok(quiz);
      assert.strictEqual(capturedBody.model, MODEL_DEEPSEEK, `Primary model for light question must be DeepSeek (${MODEL_DEEPSEEK})`);
      assert.strictEqual(capturedOpts.timeout, 30000, 'Light question timeout must be 30,000ms');
      assert.strictEqual(capturedBody.max_tokens, 450, 'Max tokens must be 450 for quiz generation');
    });

    // 3.2 Heavy material in quiz.js routes to DeepSeek
    test('3.2 quiz.js: Heavy material (math / STEM) routes to DeepSeek (primary) with 45s timeout & 450 tokens', async () => {
      let capturedBody = null;
      let capturedOpts = null;

      mockHandler = async (body, opts) => {
        capturedBody = body;
        capturedOpts = opts;
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  question: 'Berapakah integral dari 2x dx?',
                  options: { A: 'x^2 + C', B: '2x^2 + C', C: 'x + C', D: '2 + C' },
                  correct_answer: 'A',
                  explanation: 'Hasil integral dari 2x dx adalah x^2 + C.',
                }),
              },
            },
          ],
        };
      };

      const heavyStemMaterial = 'Pelajari rumus integral kalkulus tak tentu: ∫ 2x dx = x² + C.';
      const quiz = await generateQuiz(heavyStemMaterial);

      assert.ok(quiz);
      assert.strictEqual(capturedBody.model, MODEL_DEEPSEEK, `Primary model for heavy question must be DeepSeek (${MODEL_DEEPSEEK})`);
      assert.strictEqual(capturedOpts.timeout, 45000, 'Heavy question timeout must be 45,000ms');
      assert.strictEqual(capturedBody.max_tokens, 450, 'Max tokens must be 450 for quiz generation');
    });

    // 3.3 Heavy material by length in quiz.js
    test('3.3 quiz.js: Heavy material by length (>500 chars) routes to DeepSeek as primary', async () => {
      let capturedModel = null;
      mockHandler = async (body) => {
        capturedModel = body.model;
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  question: 'Apa simpulan teks panjang?',
                  options: { A: 'Opsi A', B: 'Opsi B', C: 'Opsi C', D: 'Opsi D' },
                  correct_answer: 'A',
                  explanation: 'Penjelasan umum.',
                }),
              },
            },
          ],
        };
      };

      const longProse = 'Revolusi industri mengubah tatanan sosial dunia secara bertahap. '.repeat(15);
      assert.ok(longProse.length > 500);

      await generateQuiz(longProse);
      assert.strictEqual(capturedModel, MODEL_DEEPSEEK, 'Material > 500 characters must route to DeepSeek as primary');
    });

    // 3.4 bot.js: handleExplain with light material routes to DeepSeek, 750 tokens, 45s timeout
    test('3.4 bot.js: handleExplain with light material routes to DeepSeek (primary) with 750 tokens & 45s timeout', async () => {
      const { handlers } = createMockBot();
      const chatId = 2001;

      let capturedBody = null;
      let capturedOpts = null;
      let resolveCall;
      const callPromise = new Promise((resolve) => { resolveCall = resolve; });

      mockHandler = async (body, opts) => {
        capturedBody = body;
        capturedOpts = opts;
        resolveCall();
        return {
          choices: [{ message: { content: 'Ini penjelasan fotosintesis yang gampang dipahami.' } }],
        };
      };

      // User sends light material
      handlers.message({
        chat: { id: chatId },
        text: 'Fotosintesis adalah proses pembentukan makanan pada tumbuhan hijau.',
      });

      // User clicks 'CHOICE_EXPLAIN'
      await handlers.callback_query({
        id: 'cb_explain_light',
        message: { chat: { id: chatId }, message_id: 50 },
        data: 'CHOICE_EXPLAIN',
      });

      await callPromise;
      await new Promise((r) => setTimeout(r, 20));

      assert.ok(capturedBody, 'LLM call should have been triggered');
      assert.strictEqual(capturedBody.model, MODEL_DEEPSEEK, 'Light explanation must use DeepSeek as primary');
      assert.strictEqual(capturedBody.max_tokens, 750, 'Light explanation max_tokens must be 750');
      assert.strictEqual(capturedOpts.timeout, 45000, 'Light explanation timeout must be 45,000ms');
    });

    // 3.5 bot.js: handleExplain with heavy material routes to DeepSeek, 1000 tokens, 60s timeout
    test('3.5 bot.js: handleExplain with heavy material routes to DeepSeek (primary) with 1000 tokens & 60s timeout', async () => {
      const { handlers } = createMockBot();
      const chatId = 2002;

      let capturedBody = null;
      let capturedOpts = null;
      let resolveCall;
      const callPromise = new Promise((resolve) => { resolveCall = resolve; });

      mockHandler = async (body, opts) => {
        capturedBody = body;
        capturedOpts = opts;
        resolveCall();
        return {
          choices: [{ message: { content: 'Penjelasan kalkulus integral dan diferensial.' } }],
        };
      };

      // User sends heavy STEM material
      handlers.message({
        chat: { id: chatId },
        text: 'Rumus turunan diferensial kalkulus: d/dx (x^n) = n*x^(n-1). Tentukan integral \\int x dx.',
      });

      // User clicks 'CHOICE_EXPLAIN'
      await handlers.callback_query({
        id: 'cb_explain_heavy',
        message: { chat: { id: chatId }, message_id: 51 },
        data: 'CHOICE_EXPLAIN',
      });

      await callPromise;
      await new Promise((r) => setTimeout(r, 20));

      assert.ok(capturedBody, 'LLM call should have been triggered');
      assert.strictEqual(capturedBody.model, MODEL_DEEPSEEK, 'Heavy explanation must use DeepSeek as primary');
      assert.strictEqual(capturedBody.max_tokens, 1000, 'Heavy explanation max_tokens must be 1000');
      assert.strictEqual(capturedOpts.timeout, 60000, 'Heavy explanation timeout must be 60,000ms');
    });

    // 3.6 bot.js: handleHint routes to DeepSeek, 250 tokens, 30s timeout
    test('3.6 bot.js: handleHint routes to DeepSeek (primary) with 250 tokens & 30s timeout', async () => {
      const { handlers } = createMockBot();
      const chatId = 2003;

      let capturedBody = null;
      let capturedOpts = null;
      let resolveCall;
      const callPromise = new Promise((resolve) => { resolveCall = resolve; });

      mockHandler = async (body, opts) => {
        capturedBody = body;
        capturedOpts = opts;
        resolveCall();
        return {
          choices: [{ message: { content: 'Nope, soalnya udah dikunci 🔒 Coba inget lagi rumus dasarnya!' } }],
        };
      };

      // Set chat state to locked quiz awaiting answer
      setState(chatId, {
        state: 'AWAITING_ANSWER',
        material: 'Materi aljabar dasar',
        quiz: {
          question: 'Berapakah 2x + 3 = 7?',
          options: { A: '1', B: '2', C: '3', D: '4' },
          correct_answer: 'B',
          explanation: '2x = 4 maka x = 2.',
        },
      });

      // User sends a hint or question change message
      handlers.message({
        chat: { id: chatId },
        text: 'Bisa tolong ganti pertanyaannya ga min?',
      });

      await callPromise;
      await new Promise((r) => setTimeout(r, 20));

      assert.ok(capturedBody, 'Hint LLM call should have been triggered');
      assert.strictEqual(capturedBody.model, MODEL_DEEPSEEK, 'Hint must use DeepSeek as primary');
      assert.strictEqual(capturedBody.max_tokens, 250, 'Hint max_tokens must be 250');
      assert.strictEqual(capturedOpts.timeout, 30000, 'Hint timeout must be 30,000ms');
    });

    // 3.7 quiz.js: Multimodal quiz with imageBase64 routes to DeepSeek with vision payload
    test('3.7 quiz.js: Multimodal quiz with imageBase64 routes to DeepSeek (primary) with vision payload & 45s timeout', async () => {
      let capturedBody = null;
      let capturedOpts = null;

      mockHandler = async (body, opts) => {
        capturedBody = body;
        capturedOpts = opts;
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  question: 'Berapa luas segitiga pada gambar?',
                  options: { A: '10 cm²', B: '20 cm²', C: '30 cm²', D: '40 cm²' },
                  correct_answer: 'A',
                  explanation: 'Luas segitiga adalah 1/2 kali alas kali tinggi.',
                }),
              },
            },
          ],
        };
      };

      const fakeImageBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      const quiz = await generateQuiz('Soal geometri segitiga', fakeImageBase64);

      assert.ok(quiz);
      assert.strictEqual(capturedBody.model, MODEL_DEEPSEEK, 'Multimodal quiz must use DeepSeek as primary');
      assert.strictEqual(capturedOpts.timeout, 45000, 'Multimodal quiz timeout must be 45,000ms');
      assert.strictEqual(capturedBody.max_tokens, 450, 'Max tokens must be 450');

      const userMsg = capturedBody.messages.find((m) => m.role === 'user');
      assert.ok(Array.isArray(userMsg.content), 'User message content must be an array for multimodal input');
      assert.strictEqual(userMsg.content.length, 2);
      assert.strictEqual(userMsg.content[0].type, 'text');
      assert.strictEqual(userMsg.content[1].type, 'image_url');
      assert.strictEqual(userMsg.content[1].image_url.url, fakeImageBase64);
    });

    // 3.8 bot.js: Multimodal handleExplain with imageBase64 routes to DeepSeek with vision payload
    test('3.8 bot.js: Multimodal handleExplain with imageBase64 routes to DeepSeek with vision payload & 60s timeout', async () => {
      const { handlers } = createMockBot();
      const chatId = 2004;

      let capturedBody = null;
      let capturedOpts = null;
      let resolveCall;
      const callPromise = new Promise((resolve) => { resolveCall = resolve; });

      mockHandler = async (body, opts) => {
        capturedBody = body;
        capturedOpts = opts;
        resolveCall();
        return {
          choices: [{ message: { content: 'Penjelasan diagram siklus krebs pada gambar.' } }],
        };
      };

      const fakeImageBase64 = 'data:image/jpeg;base64,1234567890';
      setState(chatId, {
        state: 'IDLE',
        material: 'Diagram respirasi sel',
        imageBase64: fakeImageBase64,
      });

      await handlers.callback_query({
        id: 'cb_explain_image',
        message: { chat: { id: chatId }, message_id: 52 },
        data: 'CHOICE_EXPLAIN',
      });

      await callPromise;
      await new Promise((r) => setTimeout(r, 20));

      assert.ok(capturedBody, 'LLM call should have been triggered');
      assert.strictEqual(capturedBody.model, MODEL_DEEPSEEK, 'Multimodal explanation must use DeepSeek as primary');
      assert.strictEqual(capturedBody.max_tokens, 1000, 'Multimodal explanation max_tokens must be 1000');
      assert.strictEqual(capturedOpts.timeout, 60000, 'Multimodal explanation timeout must be 60,000ms');

      const userMsg = capturedBody.messages.find((m) => m.role === 'user');
      assert.ok(Array.isArray(userMsg.content), 'User message content must be an array');
      assert.strictEqual(userMsg.content[1].type, 'image_url');
      assert.strictEqual(userMsg.content[1].image_url.url, fakeImageBase64);
    });
  });

  // ----------------------------------------------------
  // SUITE 4: Fallback Execution & Timeout Fix in llm.js
  // ----------------------------------------------------
  suite('4. Fallback Execution & Timeout Fix in llm.js', () => {
    test('4.1 Happy path: Primary model succeeds -> fallback model is NEVER called', async () => {
      const calls = [];

      mockHandler = async (body) => {
        calls.push(body.model);
        return {
          choices: [{ message: { content: `Response from ${body.model}` } }],
        };
      };

      const result = await ask('Halo', 'System prompt', {
        primaryModel: 'custom-primary',
        fallbackModel: 'custom-fallback',
      });

      assert.strictEqual(result, 'Response from custom-primary');
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0], 'custom-primary');
    });

    test('4.2 Error failover: Primary model throws error -> automatically executes fallbackModel', async () => {
      const calls = [];
      const warnLogs = [];
      const originalWarn = console.warn;
      console.warn = (...args) => warnLogs.push(args.join(' '));

      try {
        mockHandler = async (body) => {
          calls.push(body.model);
          if (body.model === 'primary-model-fail') {
            throw new Error('503 Service Unavailable on primary model');
          }
          return {
            choices: [{ message: { content: `Fallback response from ${body.model}` } }],
          };
        };

        const result = await ask('Tes failover', 'System prompt', {
          primaryModel: 'primary-model-fail',
          fallbackModel: 'fallback-model-success',
          timeoutMs: 15000,
        });

        assert.strictEqual(result, 'Fallback response from fallback-model-success');
        assert.strictEqual(calls.length, 2, 'Must have attempted primary first, then fallback');
        assert.strictEqual(calls[0], 'primary-model-fail');
        assert.strictEqual(calls[1], 'fallback-model-success');

        assert.ok(
          warnLogs.some((log) => log.includes('[LLM Fallback]') && log.includes('primary-model-fail')),
          'Should log fallback transition message'
        );
      } finally {
        console.warn = originalWarn;
      }
    });

    test('4.3 Timeout failover: Primary model times out (AbortError) -> executes fallbackModel', async () => {
      const calls = [];
      const warnLogs = [];
      const originalWarn = console.warn;
      console.warn = (...args) => warnLogs.push(args.join(' '));

      try {
        mockHandler = async (body, opts) => {
          calls.push(body.model);
          if (body.model === 'primary-timeout') {
            const timeoutErr = new Error('The operation was aborted due to timeout');
            timeoutErr.name = 'AbortError';
            throw timeoutErr;
          }
          return {
            choices: [{ message: { content: `Recovered by ${body.model}` } }],
          };
        };

        const result = await ask('Materi panjang', 'System prompt', {
          primaryModel: 'primary-timeout',
          fallbackModel: 'fallback-quick',
          timeoutMs: 5000,
        });

        assert.strictEqual(result, 'Recovered by fallback-quick');
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(calls[0], 'primary-timeout');
        assert.strictEqual(calls[1], 'fallback-quick');

        assert.ok(
          warnLogs.some((log) => log.includes('[LLM Fallback]') && log.includes('primary-timeout')),
          'Should log fallback warning on timeout'
        );
      } finally {
        console.warn = originalWarn;
      }
    });

    test('4.4 Outage: Primary AND fallback both fail -> throws fallback error', async () => {
      const calls = [];
      const originalWarn = console.warn;
      const originalError = console.error;
      console.warn = () => {};
      console.error = () => {};

      try {
        mockHandler = async (body) => {
          calls.push(body.model);
          if (body.model === 'primary-down') {
            throw new Error('Primary connection refused');
          }
          if (body.model === 'fallback-down') {
            throw new Error('Fallback rate limit exceeded (429)');
          }
          return { choices: [{ message: { content: 'unexpected' } }] };
        };

        await assert.rejects(
          async () => {
            await ask('Tes all fail', 'Sys', {
              primaryModel: 'primary-down',
              fallbackModel: 'fallback-down',
            });
          },
          /Fallback rate limit exceeded \(429\)/,
          'Must re-throw error from fallback model if both fail'
        );

        assert.strictEqual(calls.length, 2);
        assert.strictEqual(calls[0], 'primary-down');
        assert.strictEqual(calls[1], 'fallback-down');
      } finally {
        console.warn = originalWarn;
        console.error = originalError;
      }
    });

    test('4.5 Redundant fallback avoided if fallbackModel equals primaryModel or is falsy', async () => {
      const calls = [];
      mockHandler = async (body) => {
        calls.push(body.model);
        throw new Error('Immediate single failure');
      };

      await assert.rejects(
        async () => {
          await ask('Single model test', 'Sys', {
            primaryModel: 'identical-model',
            fallbackModel: 'identical-model',
          });
        },
        /Immediate single failure/
      );

      assert.strictEqual(calls.length, 1, 'Should not re-attempt if fallback is identical to primary');
    });

    test('4.6 Default models used when primaryModel and fallbackModel are omitted in ask()', async () => {
      const calls = [];
      mockHandler = async (body) => {
        calls.push(body.model);
        if (body.model === MODEL_DEEPSEEK) {
          throw new Error('DeepSeek timeout');
        }
        return { choices: [{ message: { content: 'Mimo response' } }] };
      };

      const originalWarn = console.warn;
      console.warn = () => {};

      try {
        const result = await ask('Default model check', 'System prompt');
        assert.strictEqual(result, 'Mimo response');
        assert.strictEqual(calls[0], MODEL_DEEPSEEK, 'Default primary model must be DeepSeek');
        assert.strictEqual(calls[1], MODEL_MIMO, 'Default fallback model must be Mimo');
      } finally {
        console.warn = originalWarn;
      }
    });

    test('4.7 Timeout fix: AbortSignal and timeout forwarded to client completions call', async () => {
      let passedOpts = null;
      mockHandler = async (body, opts) => {
        passedOpts = opts;
        return { choices: [{ message: { content: 'ok' } }] };
      };

      await ask('Ping test', 'Sys prompt', { timeoutMs: 12345 });
      assert.ok(passedOpts, 'Client options must be passed');
      assert.strictEqual(passedOpts.timeout, 12345, 'Custom timeoutMs must be forwarded to client options');
      assert.ok(passedOpts.signal instanceof AbortSignal, 'AbortSignal from AbortController must be passed');
    });

    test('4.8 Multimodal failover prevention: ask() with opts.imageBase64 skips text fallback on error', async () => {
      const calls = [];
      mockHandler = async (body) => {
        calls.push(body.model);
        throw new Error('Vision processing failed on primary model');
      };

      await assert.rejects(
        async () => {
          await ask('Prompt gambar', 'Sys', {
            primaryModel: MODEL_DEEPSEEK,
            fallbackModel: MODEL_MIMO,
            imageBase64: 'data:image/png;base64,abc123',
          });
        },
        /Vision processing failed on primary model/
      );

      assert.strictEqual(calls.length, 1, 'Should not call text-only fallback when imageBase64 is provided');
      assert.strictEqual(calls[0], MODEL_DEEPSEEK);
    });

    test('4.9 Empty response handling: model returning empty content or whitespace triggers failover or throws', async () => {
      const calls = [];
      const originalWarn = console.warn;
      console.warn = () => {};

      try {
        mockHandler = async (body) => {
          calls.push(body.model);
          if (body.model === MODEL_DEEPSEEK) {
            return { choices: [{ message: { content: '   ' } }] };
          }
          return { choices: [{ message: { content: 'Recovered from empty primary' } }] };
        };

        const result = await ask('Tes empty output', 'Sys');
        assert.strictEqual(result, 'Recovered from empty primary');
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(calls[0], MODEL_DEEPSEEK);
        assert.strictEqual(calls[1], MODEL_MIMO);
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  // ----------------------------------------------------
  // SUITE 5: extractJson Resilience
  // ----------------------------------------------------
  suite('5. extractJson Resilience (commas, fences, leading & trailing text)', () => {
    test('5.1 Parses standard valid JSON cleanly', () => {
      const input = '{"question": "Apa itu fotosintesis?", "answer": "A"}';
      const parsed = extractJson(input);
      assert.deepStrictEqual(parsed, { question: 'Apa itu fotosintesis?', answer: 'A' });
    });

    test('5.2 Handles trailing commas in JSON objects', () => {
      const input = '{"question": "Berapakah 1+1?", "options": {"A": "2", "B": "3",}, "correct_answer": "A",}';
      const parsed = extractJson(input);
      assert.strictEqual(parsed.question, 'Berapakah 1+1?');
      assert.strictEqual(parsed.options.A, '2');
      assert.strictEqual(parsed.options.B, '3');
      assert.strictEqual(parsed.correct_answer, 'A');
    });

    test('5.3 Handles trailing commas in JSON arrays and nested structures', () => {
      const input = '{\n  "items": [\n    "satu",\n    "dua",\n    "tiga",\n  ],\n  "nested": {\n    "val": 42,\n  },\n}';
      const parsed = extractJson(input);
      assert.deepStrictEqual(parsed.items, ['satu', 'dua', 'tiga']);
      assert.strictEqual(parsed.nested.val, 42);
    });

    test('5.4 Handles markdown code fences with language identifier (```json ... ```)', () => {
      const input = '```json\n{\n  "question": "Soal dalam fence json",\n  "options": { "A": "1", "B": "2", "C": "3", "D": "4" },\n  "correct_answer": "B",\n  "explanation": "Penjelasan"\n}\n```';
      const parsed = extractJson(input);
      assert.strictEqual(parsed.question, 'Soal dalam fence json');
      assert.strictEqual(parsed.correct_answer, 'B');
    });

    test('5.5 Handles markdown code fences without language identifier (``` ... ```)', () => {
      const input = '```\n{\n  "question": "Soal dalam fence polos",\n  "options": { "A": "X", "B": "Y", "C": "Z", "D": "W" },\n  "correct_answer": "C",\n  "explanation": "Penjelasan"\n}\n```';
      const parsed = extractJson(input);
      assert.strictEqual(parsed.question, 'Soal dalam fence polos');
      assert.strictEqual(parsed.correct_answer, 'C');
    });

    test('5.6 Handles leading commentary text before JSON', () => {
      const input = 'Tentu! Berikut adalah kuis pilihan ganda yang lu minta:\n\n{\n  "question": "Ibukota Perancis?",\n  "options": { "A": "Paris", "B": "Lyon", "C": "Nice", "D": "Marseille" },\n  "correct_answer": "A",\n  "explanation": "Paris adalah ibukota Perancis."\n}';
      const parsed = extractJson(input);
      assert.strictEqual(parsed.question, 'Ibukota Perancis?');
      assert.strictEqual(parsed.correct_answer, 'A');
    });

    test('5.7 Handles trailing commentary text after JSON', () => {
      const input = '{\n  "question": "Rumus gravitasi?",\n  "options": { "A": "F=GmM/r^2", "B": "F=ma", "C": "E=mc^2", "D": "p=mv" },\n  "correct_answer": "A",\n  "explanation": "Hukum gravitasi Newton."\n}\n\nSemoga membantu proses belajar lu ya!';
      const parsed = extractJson(input);
      assert.strictEqual(parsed.question, 'Rumus gravitasi?');
      assert.strictEqual(parsed.correct_answer, 'A');
    });

    test('5.8 Handles complex combined LLM output: leading commentary + markdown code fence + trailing commas + trailing commentary', () => {
      const input =
        'Halo! Ini soal kuis berdasarkan materi lu:\n\n' +
        '```json\n' +
        '{\n' +
        '  "question": "Manakah planet terbesar di tata surya?",\n' +
        '  "options": {\n' +
        '    "A": "Bumi",\n' +
        '    "B": "Mars",\n' +
        '    "C": "Jupiter",\n' +
        '    "D": "Saturnus",\n' +
        '  },\n' +
        '  "correct_answer": "C",\n' +
        '  "explanation": "Jupiter memiliki massa terbesar.",\n' +
        '}\n' +
        '```\n\n' +
        'Gimana? Mau lanjut kuis materi lain?';

      const parsed = extractJson(input);
      assert.ok(parsed);
      assert.strictEqual(parsed.question, 'Manakah planet terbesar di tata surya?');
      assert.strictEqual(parsed.correct_answer, 'C');
      assert.strictEqual(parsed.options.C, 'Jupiter');
      assert.strictEqual(parsed.explanation, 'Jupiter memiliki massa terbesar.');
    });

    test('5.9 Throws clean error when output contains no valid JSON object', () => {
      const invalidInputs = [
        'Maaf, saya tidak bisa membuat kuis untuk materi ini.',
        'Here is your answer: none.',
        '',
        '{ not valid json at all }',
      ];

      for (const badInput of invalidInputs) {
        assert.throws(
          () => extractJson(badInput),
          'Expected extractJson to throw on non-JSON input'
        );
      }
    });
  });

  // ----------------------------------------------------
  // SUITE 6: End-to-End Fallback in Quiz Generation
  // ----------------------------------------------------
  suite('6. End-to-End Fallback in Quiz Generation (generateQuiz)', () => {
    test('6.1 Text quiz failover: DeepSeek fails -> Mimo recovers and produces valid quiz', async () => {
      const calls = [];
      const originalWarn = console.warn;
      console.warn = () => {};

      try {
        mockHandler = async (body) => {
          calls.push(body.model);
          if (body.model === MODEL_DEEPSEEK) {
            throw new Error('500 Internal Server Error on DeepSeek');
          }
          return {
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    question: 'Siklus air dimulai dari proses penguapan yang disebut?',
                    options: {
                      A: 'Evaporasi',
                      B: 'Kondensasi',
                      C: 'Presipitasi',
                      D: 'Infiltrasi',
                    },
                    correct_answer: 'A',
                    explanation: 'Evaporasi adalah proses perubahan air menjadi uap air.',
                  }),
                },
              },
            ],
          };
        };

        const quiz = await generateQuiz('Siklus hidrologi air di bumi');
        assert.ok(quiz);
        assert.strictEqual(quiz.correct_answer, 'A');
        assert.strictEqual(quiz.options.A, 'Evaporasi');
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(calls[0], MODEL_DEEPSEEK, 'First attempt must call DeepSeek (universal primary)');
        assert.strictEqual(calls[1], MODEL_MIMO, 'Fallback must call Mimo');
      } finally {
        console.warn = originalWarn;
      }
    });

    test('6.2 Heavy quiz: DeepSeek fails -> Mimo recovers and produces valid quiz with JSON auto-repair', async () => {
      const calls = [];
      const originalWarn = console.warn;
      console.warn = () => {};

      try {
        mockHandler = async (body) => {
          calls.push(body.model);
          if (body.model === MODEL_DEEPSEEK) {
            throw new Error('DeepSeek service unavailable');
          }
          // Return raw JSON with trailing comma to verify auto-repair in fallback path
          return {
            choices: [
              {
                message: {
                  content: '```json\n{\n  "question": "Berapakah turunan pertama dari f(x) = x³?",\n  "options": {\n    "A": "3x²",\n    "B": "x²",\n    "C": "3x",\n    "D": "x³",\n  },\n  "correct_answer": "A",\n  "explanation": "Turunan dari x^n adalah n*x^(n-1).",\n}\n```',
                },
              },
            ],
          };
        };

        const heavyMaterial = 'Turunan fungsi aljabar kalkulus f(x) = x^n adalah f\'(x) = n*x^(n-1).';
        const quiz = await generateQuiz(heavyMaterial);

        assert.ok(quiz);
        assert.strictEqual(quiz.correct_answer, 'A');
        assert.strictEqual(calls[0], MODEL_DEEPSEEK, 'Heavy material must try DeepSeek first');
        assert.strictEqual(calls[1], MODEL_MIMO, 'Fallback must try Mimo second');
      } finally {
        console.warn = originalWarn;
      }
    });

    test('6.3 Bad JSON on attempt 1 triggers attempt 2 with emphatic schema prompt', async () => {
      let attemptCount = 0;
      const promptsReceived = [];

      mockHandler = async (body) => {
        attemptCount++;
        const userMsg = body.messages.find((m) => m.role === 'user').content;
        promptsReceived.push(userMsg);

        if (attemptCount === 1) {
          // Model returns non-JSON commentary on first attempt
          return { choices: [{ message: { content: 'Tentu, ini kuisnya: Pertanyaan 1...' } }] };
        }
        // Valid JSON on second attempt
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  question: 'Soal setelah retry',
                  options: { A: 'A', B: 'B', C: 'C', D: 'D' },
                  correct_answer: 'C',
                  explanation: 'Penjelasan benar C',
                }),
              },
            },
          ],
        };
      };

      const quiz = await generateQuiz('Materi singkat untuk retry');
      assert.strictEqual(attemptCount, 2);
      assert.ok(quiz);
      assert.strictEqual(quiz.correct_answer, 'C');
      assert.ok(
        promptsReceived[1].includes('(PENTING: kembalikan HANYA JSON valid sesuai schema, tanpa teks lain!)'),
        'Second attempt must include strict schema reminder'
      );
    });

    test('6.4 Overly long material (>3000 chars) is truncated before sending to model', async () => {
      let capturedPrompt = null;
      mockHandler = async (body) => {
        capturedPrompt = body.messages.find((m) => m.role === 'user').content;
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  question: 'Pertanyaan ringkasan materi panjang',
                  options: { A: 'A', B: 'B', C: 'C', D: 'D' },
                  correct_answer: 'A',
                  explanation: 'Penjelasan ringkas',
                }),
              },
            },
          ],
        };
      };

      const massiveMaterial = 'Data historis penting peradaban kuno: '.repeat(200); // ~7600 chars
      assert.ok(massiveMaterial.length > 3000);

      await generateQuiz(massiveMaterial);
      assert.ok(capturedPrompt.includes('(...materi dipotong karena kepanjangan)'));
    });

    test('6.5 Keyboard builder returns exactly 4 buttons (A, B, C, D) in 1 row', () => {
      const kb = buildQuizKeyboard();
      assert.ok(kb && kb.inline_keyboard);
      assert.strictEqual(kb.inline_keyboard.length, 1);
      assert.strictEqual(kb.inline_keyboard[0].length, 4);
      assert.deepStrictEqual(
        kb.inline_keyboard[0].map((b) => b.callback_data),
        ['ANS_A', 'ANS_B', 'ANS_C', 'ANS_D']
      );
    });

    test('6.6 Multimodal quiz generation creates valid quiz directly from image with empty caption', async () => {
      let capturedUserContent = null;
      mockHandler = async (body) => {
        capturedUserContent = body.messages.find((m) => m.role === 'user').content;
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
                  question: 'Berapakah nilai tegangan V pada rangkaian?',
                  options: { A: '12V', B: '24V', C: '6V', D: '3V' },
                  correct_answer: 'A',
                  explanation: 'Hukum Ohm menyatakan V = I * R.',
                }),
              },
            },
          ],
        };
      };

      const fakeImage = 'data:image/png;base64,circuit_diagram_data';
      const quiz = await generateQuiz('', fakeImage);

      assert.ok(quiz);
      assert.strictEqual(quiz.correct_answer, 'A');
      assert.strictEqual(quiz.options.A, '12V');
      assert.ok(Array.isArray(capturedUserContent));
      assert.strictEqual(capturedUserContent[0].type, 'text');
      assert.strictEqual(
        capturedUserContent[0].text,
        'Analisis materi pelajaran pada gambar berikut dan buat 1 soal kuis pilihan ganda.'
      );
      assert.strictEqual(capturedUserContent[1].image_url.url, fakeImage);
    });
  });

  // ----------------------------------------------------
  // SUITE 7: Telegram Multimodal Image Handling in bot.js
  // ----------------------------------------------------
  suite('7. Telegram Multimodal Image Handling in bot.js', () => {
    test('7.1 downloadTelegramImageAsBase64 downloads image and returns data URL', async () => {
      const originalFetch = global.fetch;
      try {
        const mockBuffer = Buffer.from('fake-binary-image-data');
        global.fetch = async (url, opts) => {
          return {
            ok: true,
            status: 200,
            headers: { get: () => 'image/png' },
            arrayBuffer: async () =>
              mockBuffer.buffer.slice(mockBuffer.byteOffset, mockBuffer.byteOffset + mockBuffer.byteLength),
          };
        };

        const mockBotInstance = {
          getFileLink: async (fileId) => `https://api.telegram.org/file/bot/${fileId}.png`,
        };

        const dataUrl = await downloadTelegramImageAsBase64(mockBotInstance, 'test_file_id_123', 'image/png');
        assert.ok(dataUrl.startsWith('data:image/png;base64,'));
        const decoded = Buffer.from(dataUrl.replace('data:image/png;base64,', ''), 'base64').toString();
        assert.strictEqual(decoded, 'fake-binary-image-data');
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('7.2 bot.on message with photo saves imageBase64 & caption and shows CHOICE_KEYBOARD', async () => {
      const originalFetch = global.fetch;
      try {
        global.fetch = async () => ({
          ok: true,
          status: 200,
          headers: { get: () => 'image/jpeg' },
          arrayBuffer: async () => Buffer.from('sample-photo').buffer,
        });

        const { mockBot, handlers, sentMessages } = createMockBot();
        mockBot.getFileLink = async (fileId) => `https://api.telegram.org/file/bot/${fileId}`;

        const chatId = 3001;
        await handlers.message({
          chat: { id: chatId },
          photo: [
            { file_id: 'thumb_id', width: 100, height: 100 },
            { file_id: 'highres_id', width: 800, height: 800 },
          ],
          caption: 'Tolong jelaskan rumus di papan tulis ini',
        });

        const s = getState(chatId);
        assert.strictEqual(s.state, 'IDLE');
        assert.strictEqual(s.material, 'Tolong jelaskan rumus di papan tulis ini');
        assert.ok(s.imageBase64 && s.imageBase64.startsWith('data:image/jpeg;base64,'));

        const lastMsg = sentMessages[sentMessages.length - 1];
        assert.ok(lastMsg.text.includes('dapet gambarnya! 📸'));
        assert.ok(lastMsg.opts && lastMsg.opts.reply_markup);
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('7.3 bot.on message with image document saves imageBase64 and shows CHOICE_KEYBOARD', async () => {
      const originalFetch = global.fetch;
      try {
        global.fetch = async () => ({
          ok: true,
          status: 200,
          headers: { get: () => 'image/png' },
          arrayBuffer: async () => Buffer.from('document-photo').buffer,
        });

        const { mockBot, handlers, sentMessages } = createMockBot();
        mockBot.getFileLink = async (fileId) => `https://api.telegram.org/file/bot/${fileId}`;

        const chatId = 3002;
        await handlers.message({
          chat: { id: chatId },
          document: {
            file_id: 'doc_image_id',
            mime_type: 'image/png',
          },
          caption: '',
        });

        const s = getState(chatId);
        assert.strictEqual(s.state, 'IDLE');
        assert.strictEqual(s.material, '');
        assert.ok(s.imageBase64 && s.imageBase64.startsWith('data:image/png;base64,'));

        const lastMsg = sentMessages[sentMessages.length - 1];
        assert.ok(lastMsg.text.includes('dapet gambarnya! 📸'));
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('7.4 Image received during locked quiz refuses change and prompts to finish quiz', async () => {
      const { handlers, sentMessages } = createMockBot();
      const chatId = 3003;

      setState(chatId, {
        state: 'AWAITING_ANSWER',
        material: 'Materi lama',
        quiz: {
          question: 'Soal aktif?',
          options: { A: '1', B: '2', C: '3', D: '4' },
          correct_answer: 'A',
          explanation: 'Penjelasan',
        },
      });

      await handlers.message({
        chat: { id: chatId },
        photo: [{ file_id: 'another_pic' }],
      });

      const s = getState(chatId);
      assert.strictEqual(s.state, 'AWAITING_ANSWER');
      assert.ok(s.quiz);
      const lastMsg = sentMessages[sentMessages.length - 1];
      assert.ok(lastMsg.text.includes('soalnya udah dikunci 🔒'));
    });

    test('7.5 In-memory imageBase64 is cleared after handleQuiz completes', async () => {
      const { handlers } = createMockBot();
      const chatId = 390000 + Math.floor(Math.random() * 10000);

      mockHandler = async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                question: 'Soal dari gambar',
                options: { A: 'A', B: 'B', C: 'C', D: 'D' },
                correct_answer: 'B',
                explanation: 'Penjelasan kuis gambar',
              }),
            },
          },
        ],
      });

      setState(chatId, {
        state: 'IDLE',
        material: '',
        imageBase64: 'data:image/png;base64,dummy_bytes',
      });

      await handlers.callback_query({
        id: 'cb_quiz_image_cleanup',
        message: { chat: { id: chatId }, message_id: 100 },
        data: 'CHOICE_QUIZ',
      });

      await new Promise((r) => setTimeout(r, 30));

      const s = getState(chatId);
      assert.strictEqual(s.state, 'AWAITING_ANSWER');
      assert.strictEqual(s.imageBase64, null, 'imageBase64 must be nullified to prevent memory leaks');
    });

    test('7.6 In-memory imageBase64 is cleared after handleExplain completes', async () => {
      const { handlers } = createMockBot();
      const chatId = 3005;

      mockHandler = async () => ({
        choices: [{ message: { content: 'Penjelasan gambar selesai.' } }],
      });

      setState(chatId, {
        state: 'IDLE',
        material: 'Materi gambar',
        imageBase64: 'data:image/jpeg;base64,dummy_bytes_explain',
      });

      await handlers.callback_query({
        id: 'cb_explain_image_cleanup',
        message: { chat: { id: chatId }, message_id: 101 },
        data: 'CHOICE_EXPLAIN',
      });

      await new Promise((r) => setTimeout(r, 30));

      const s = getState(chatId);
      assert.strictEqual(s.state, 'IDLE');
      assert.strictEqual(s.imageBase64, null, 'imageBase64 must be nullified to prevent memory leaks');
    });

    test('7.7 sendSmart replaces empty or whitespace text with ERROR_MSG to prevent Telegram 400 Bad Request', async () => {
      const { mockBot, sentMessages } = createMockBot();
      const chatId = 3006;

      await sendSmart(mockBot, chatId, '');
      assert.strictEqual(sentMessages.length, 1);
      assert.strictEqual(sentMessages[0].text, ERROR_MSG);

      await sendSmart(mockBot, chatId, '   \n  ');
      assert.strictEqual(sentMessages.length, 2);
      assert.strictEqual(sentMessages[1].text, ERROR_MSG);
    });

    test('7.8 splitIntoChunks breaks text > 4000 chars into smaller chunks at paragraph or newline boundaries', () => {
      const p1 = 'Bagian awal paragraf pertama: ' + 'A'.repeat(2500);
      const p2 = 'Bagian paragraf kedua: ' + 'B'.repeat(2500);
      const longText = p1 + '\n\n' + p2;
      assert.ok(longText.length > 4000);

      const chunks = splitIntoChunks(longText, 4000);
      assert.strictEqual(chunks.length, 2);
      for (const chunk of chunks) {
        assert.ok(chunk.length <= 4000, `Chunk length ${chunk.length} should be <= 4000`);
      }
      assert.ok(chunks[0].includes('Bagian awal paragraf pertama:'));
      assert.ok(chunks[1].includes('Bagian paragraf kedua:'));
    });

    test('7.9 sendSmart sends multiple sequential messages when text exceeds 4000 chars and attaches markup to last chunk only', async () => {
      const { mockBot, sentMessages } = createMockBot();
      const chatId = 3007;

      const longExplanation = 'Paragraf 1: ' + 'X'.repeat(3500) + '\n\nParagraf 2: ' + 'Y'.repeat(2500);
      assert.ok(longExplanation.length > 4000);

      const fakeMarkup = { inline_keyboard: [[{ text: 'Tombol', callback_data: 'TEST' }]] };
      await sendSmart(mockBot, chatId, longExplanation, { reply_markup: fakeMarkup });

      assert.strictEqual(sentMessages.length, 2, 'Must deliver 2 messages sequentially');
      assert.strictEqual(sentMessages[0].opts.reply_markup, undefined, 'First chunk should not have reply_markup');
      assert.deepStrictEqual(sentMessages[1].opts.reply_markup, fakeMarkup, 'Final chunk must have reply_markup');
      assert.ok(sentMessages[0].text.length <= 4000);
      assert.ok(sentMessages[1].text.length <= 4000);
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

// Execute and format report
(async () => {
  const overallStart = performance.now();
  await runAllTests();
  const overallDuration = (performance.now() - overallStart).toFixed(2);

  // Restore prototype
  clientPrototype.create = originalCreate;

  // Print formatted results
  const suites = [...new Set(testResults.map((r) => r.suite))];
  const passed = testResults.filter((r) => r.status === 'PASS').length;
  const failed = testResults.filter((r) => r.status === 'FAIL').length;
  const total = testResults.length;

  console.log('='.repeat(80));
  console.log(' GAMPANGBOT AUTOMATED TEST SUITE: ROUTING, PRIVACY, TIMEOUT & RESILIENCE');
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
