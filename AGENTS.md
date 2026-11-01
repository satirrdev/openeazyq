# AGENTS.md: Developer & Agent Guide for GampangBot

Compact operational guide for AI agents working in this repository.

## 1. Quick Reference & Commands
- **Runtime:** Node.js v18+ (tested on Node v20/v22, CommonJS modules).
- **Run the bot:** `node index.js` (or `npm start`).
- **Syntax validation (fast verification):**
  ```bash
  node -c index.js bot.js llm.js quiz.js math.js store.js
  ```
- **Single test / test script:** No formal test runner (Jest/Mocha) is installed. Run targeted verification scripts directly: `node <script_path>.js`.

## 2. Architecture & File Roles
```
index.js  --> Entry point: loads .env, initializes TelegramBot long-polling, attaches error handler.
bot.js    --> Bot event wiring (message, callback_query), in-memory chat state machine, sendSmart wrapper.
llm.js    --> OpenAI client instance, ask() with primary-to-fallback failover, extractJson() auto-repair.
quiz.js   --> System prompts (quiz, explain, hint), quiz generator with JSON validation/retry, keyboard builders.
math.js   --> latexToUnicode() regex pipeline converting LaTeX syntax into clean Unicode for Telegram.
store.js  --> Quota tracking & premium store, atomic persistence to data/users.json.
```

## 3. Environment Variables (.env)
Required keys in `.env` (never commit `.env`):
- `TELEGRAM_BOT_TOKEN`: Telegram bot token from BotFather.
- `AI_BASE_URL`: OpenAI-compatible endpoint (e.g., `https://tokenharbor.ai/v1`).
- `AI_API_KEY`: API key for the AI provider.
- `AI_MODEL_NAME`: Primary model ID (defaults to `deepseek-v4.1-flash:free` if unset).
- `AI_FALLBACK_MODEL_NAME`: Automatic failover model (defaults to `mimo-v2.6-flash:free`).
- `ADMIN_ID`: Telegram user ID of admin authorized to run `/upgrade`.
- `PORT`: Optional port (defaults to 3000).

## 4. State Machine & Concurrency Guardrails
State is stored in an in-memory Map in `bot.js` keyed by `chatId`.
- **States:** `IDLE`, `QUIZ_ACTIVE`, `EXPLAIN_ACTIVE`, `AWAITING_ANSWER`, `QUIZ_DONE`.
- **Concurrency Locks:** While state is `QUIZ_ACTIVE` or `EXPLAIN_ACTIVE`, ignore new clicks/messages and notify the user (`"Sabar ya, lagi diproses nih... ⏳"`).
- **Locked Quiz State (`AWAITING_ANSWER`):** When waiting for an answer to an active quiz, any text message routes to `handleHint()`. The question remains locked; never overwrite or regenerate an unanswered question unless explicitly reset.
- **Double-click Prevention:** Answer buttons (`ANS_*`) transition immediately to `QUIZ_DONE` and wipe reply markup.

## 5. Telegram Formatting & Markdown Quirks
Telegram's `parse_mode: 'Markdown'` crashes with `400 Bad Request: can't parse entities` on unescaped symbols (`_`, `*`, `[`, `` ` ``) frequently produced in math or LLM answers.
- **Always send via `sendSmart(bot, chatId, text, opts)`:**
  1. Converts LaTeX to Unicode via `latexToUnicode()` in `math.js`.
  2. Splits payloads > 4000 characters via `splitIntoChunks()` to respect Telegram's message length limits.
  3. Attempts Markdown delivery.
  4. Catches entity parse errors and falls back to plain text with formatting tokens stripped.
- Clean raw LLM text with `cleanMarkdown()` before sending to strip stray fences and convert Markdown headings (`#`) to bold (`**`).

## 6. LLM Integration & Robustness Rules
- **Client Configuration:**
  - `maxRetries: 0` on the OpenAI client instance to eliminate invisible SDK retry explosions and enforce predictable failover deadlines.
- **Universal Primary Model:**
  - All workflows (quiz, explanation, hint) route to `deepseek-v4.1-flash:free` as the primary model.
  - Text-only prompts retain `mimo-v2.6-flash:free` as an automatic failover model.
- **Token Budgeting, Temperature & Timeouts:**
  - Default module timeout: `75s` (`75000ms`).
  - Temperature: defaults to `0.2` (range 0.2 - 0.3) for deterministic, hallucination-free exam reasoning.
  - Stop sequences: passes `stop: ["}\n\n", "}\n```"]` with safe fallback retry if unsupported by upstream provider.
  - Quiz generation: `max_tokens: 800`, timeout `30s` (light) / `45s` (heavy or image).
  - Explanations: `max_tokens: 2500` (light, timeout `75s`) / `3200` (heavy or image, timeout `90s`).
  - Hints: `max_tokens: 400`, timeout `30s` (text-only).
- **JSON Parsing & Truncation Resilience:** Always use `extractJson()` in `llm.js`. It strips fences, slices `{ ... }`, repairs trailing commas, and auto-repairs truncated outputs cut off mid-sentence, with unclosed parentheses, quotes, or missing closing braces.
- **Input Guard:** Caps user text material at 1500 characters (`userText.slice(0, 1500)`). Truncates quiz material to 1500 chars (`MAX_MATERIAL_CHARS = 1500`).
- **Conceptual Tutor Prompt:** Explanations and quiz explanations must be solid and substantive (not too light or superficial). Explanations strictly follow the 3-bullet structure:
  - 🎯 Konsep Inti (1-2 sentences)
  - ⚙️ Cara Kerja / Rumus Kunci (bullet points, max 4 lines)
  - 💡 Jebakan Ujian / Tips Cepat (1-2 sentences)
  No introductory greetings or conversational filler.
- **Prompt Guard:** Keep the prompt rule prohibiting models from calculating/deriving math solutions; models must only output the JSON schema.
- **Languages:** All user-facing bot messages, buttons, and error notices must remain in casual Indonesian (*Bahasa Indonesia santai*). Developer logs and internal docs remain in English.

## 7. Multimodal Image Support
- **Supported Formats:** Telegram photos (`msg.photo`, selecting highest resolution) and image documents (`msg.document` with `image/*` MIME type).
- **Downloader:** `downloadTelegramImageAsBase64` downloads files via `bot.getFileLink` using native fetch and converts to Base64 data URLs.
- **Vision Payload:** Formats user content with OpenAI-compatible `image_url` blocks for DeepSeek v4.1-flash.
- **Vision Failover Guard:** If an image is attached, failover to text-only Mimo is blocked and the error is re-thrown.
- **Memory Hygiene:** In-memory `imageBase64` is nullified immediately after quiz or explanation generation completes to prevent memory leaks.

## 8. Quota Limits & Premium Tier (`store.js`)
- **Daily Quotas:** Free users are limited to:
  - 5 quizzes per day (`DAILY_QUIZ_LIMIT = 5`).
  - 15 conceptual explanations per day (`DAILY_EXPLAIN_LIMIT = 15`).
  - 5 image uploads per day (`DAILY_IMAGE_LIMIT = 5`).
- **Timezone & Reset:** Asia/Jakarta (00:00 WIB reset). Uses lazy reset comparing `user.lastQuizDate` with `YYYY-MM-DD` from `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' })`.
- **Unlimited Premium Tier:** Active premium users (`user.premiumUntil > Date.now()`) have unlimited quiz, explanation, and image attempts.
- **Quota Accounting:** Quotas are only decremented (`recordQuizUsage`, `recordExplainUsage`, `recordImageUsage`) after generation and message delivery succeed.
- **Persistence:** In-memory store atomically persists to `data/users.json` via temporary write (`data/users.json.tmp`) and `fs.renameSync`.
- **User & Admin Commands:**
  - `/quiz [materi]`: Generates a multiple-choice quiz directly. Supports `/quiz <materi>` or `/quiz` without arguments (uses pre-existing material, uploaded image, or conversation history; prompts if empty).
  - `/ceklimit`: Displays user quota status across quizzes, explanations, and image uploads (or active premium status with Jakarta expiry date).
  - `/iduser`: Sends caller's Telegram user ID (`msg.from.id`) to provide to the owner for manual upgrade.
  - `/upgrade <userId> <days>`: Restricted to `ADMIN_ID`. Extends active premium or starts fresh from `Date.now()`. Notifies the target user upon success.
  - `setMyCommands`: Registers Telegram menu shortcuts (`start`, `quiz`, `reset`, `ceklimit`, `iduser`) upon startup with graceful error handling.

## 9. Conversation Memory & Context Window
- **Sliding Window:** In-memory `history` array inside `getState(chatId)` retains up to 8 messages (4 user-assistant turns).
- **FIFO Pruning:** `appendHistory()` automatically trims oldest entries when exceeding 8 messages.
- **Multimodal Safety:** Raw Base64 data URLs are never stored in `history`; image inputs are replaced with placeholder `[Materi visual/gambar terlampir]`.
- **Follow-up Routing:** Short user messages (<= 400 chars) sent while `history` is active are routed directly to `handleFollowUp()` without presenting `CHOICE_KEYBOARD`.
- **Reset Triggers:** Memory is cleared upon `/reset`, `/start`, new image uploads, or text material exceeding 400 characters.

## 10. Inactivity User Data Purge
- **30-Minute Idle Purge:** If a user does not interact with the bot for 30 minutes (`IDLE_TTL_MS = 1800000`), in-memory session data (chat state, study material, image Base64 buffers, and conversation history) is completely deleted.
- **Dual-Layer Enforcement:**
  - Lazy check inside `getState(chatId)` resets expired sessions upon next message.
  - Periodic background sweep via `cleanupIdleUsers()` runs every 5 minutes with unref'd timer.

