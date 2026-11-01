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
  2. Attempts Markdown delivery.
  3. Catches entity parse errors and falls back to plain text with formatting tokens stripped.
- Clean raw LLM text with `cleanMarkdown()` before sending to strip stray fences and convert Markdown headings (`#`) to bold (`**`).

## 6. LLM Integration & Robustness Rules
- **Client Configuration:**
  - `maxRetries: 0` on the OpenAI client instance to eliminate invisible SDK retry explosions and enforce predictable failover deadlines.
- **Dynamic Model Routing:**
  - Light prompts (short text, non-STEM concepts, hints) -> primary: Mimo v2.6 (`mimo-v2.6-flash:free`), fallback: DeepSeek (`deepseek-v4.1-flash:free`).
  - Heavy prompts (long text >500 chars, complex STEM / formulas / code) -> primary: DeepSeek (`deepseek-v4.1-flash:free`), fallback: Mimo v2.6 (`mimo-v2.6-flash:free`).
- **Token Budgeting & Timeouts:**
  - Quiz generation: `max_tokens: 450`, timeout `30s` (light) / `45s` (heavy).
  - Explanations: `max_tokens: 750` (light, timeout `45s`) / `1000` (heavy, timeout `60s`).
  - Hints: `max_tokens: 250`, timeout `30s`.
- **JSON Parsing:** Always use `extractJson()` in `llm.js`. It strips fences, slices `{ ... }`, and automatically repairs trailing commas before parsing.
- **Prompt Guard:** Keep the prompt rule prohibiting models from calculating/deriving math solutions; models must only output the JSON schema.
- **Languages:** All user-facing bot messages, buttons, and error notices must remain in casual Indonesian (*Bahasa Indonesia santai*). Developer logs and internal docs remain in English.

## 7. Quiz Quota & Premium Tier (`store.js`)
- **Daily Quota:** Free users are limited to 5 quizzes per day.
- **Timezone & Reset:** Asia/Jakarta (00:00 WIB reset). Uses lazy reset comparing `user.lastQuizDate` with `YYYY-MM-DD` from `Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' })`.
- **Unlimited Features:**
  - Active premium users (`user.premiumUntil > Date.now()`) have unlimited quiz attempts.
  - Material explanation (`CHOICE_EXPLAIN`) is always unlimited for everyone.
- **Quota Accounting:** Quota is only decremented (`recordQuizUsage`) after quiz generation and message delivery succeed.
- **Persistence:** In-memory store atomically persists to `data/users.json` via temporary write (`data/users.json.tmp`) and `fs.renameSync`.
- **User & Admin Commands:**
  - `/ceklimit`: Displays user quota status (remaining/total for free users, or active premium status with Jakarta expiry date).
  - `/iduser`: Sends caller's Telegram user ID (`msg.from.id`) to provide to the owner for manual upgrade.
  - `/upgrade <userId> <days>`: Restricted to `ADMIN_ID`. Extends active premium or starts fresh from `Date.now()`. Notifies the target user upon success.
  - `setMyCommands`: Registers Telegram menu shortcuts (`start`, `ceklimit`, `iduser`) upon startup with graceful error handling.

