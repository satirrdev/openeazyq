# GampangBot System & Agent Improvement Record

Prepared for: **Satir**  
Last Updated: October 2026

---

## 1. Executive Summary

This document records the architectural improvements applied to **GampangBot** (the Telegram exam prep bot) and the operational protocols adopted by the AI Agent assisting **Satir**. All improvements address concrete failure modes identified during testing without introducing speculative or unused abstractions.

---

## 2. Application Improvements

### A. Telegram Entity Parse Safety
- **Root Cause:** Telegram's Markdown parser throws `400 Bad Request: can't parse entities` whenever raw mathematical text contains isolated formatting characters (`_`, `*`, `[`, `` ` ``). In `bot.js`, the answer submission handler bypassed `sendSmart()` and invoked `bot.sendMessage()` directly with `{ parse_mode: 'Markdown' }`.
- **Implementation:** Answer callbacks now route through `sendSmart()`, ensuring LaTeX is converted to Unicode first and unparsable Markdown automatically falls back to plain text.

### B. State Concurrency & Race Condition Locks
- **Root Cause:** If a user submitted new material or pressed inline buttons while the AI was generating a response, the in-memory state was overwritten immediately. When the background task finished, it corrupted active quizzes or produced duplicate messages.
- **Implementation:** Added `QUIZ_ACTIVE` and `EXPLAIN_ACTIVE` state locks. If a user sends a message or triggers a callback during active inference, the bot answers immediately with a non-destructive waiting notice (`Sabar ya, lagi diproses nih... ⏳`).

### C. Dual-Model Automatic Failover Engine
- **Root Cause:** Free-tier endpoints occasionally return `429 Too Many Requests`, `503 Service Unavailable`, or connection timeouts. Relying on a single model caused hard user-facing failures.
- **Implementation:** Configured a primary model (`deepseek-v4.1-flash:free`) and an automatic fallback model (`mimo-v2.6-flash:free`). If the primary model fails or times out, `ask()` immediately attempts completion with the fallback model before reporting an error.

### D. Resilient JSON Auto-Repair
- **Root Cause:** Small or fast LLMs frequently produce JSON with trailing commas (e.g. `{"options": {"A": "...",},}`) or markdown fence variations.
- **Implementation:** `extractJson()` strips code fences, extracts the root `{ ... }` block, and removes trailing commas before parsing.

---

## 3. System Workflows ("If ... not working, then ...")

### Workflow 1: User Request & State Guard
```text
IF user sends a message or clicks a button:
  ├── IF state is QUIZ_ACTIVE or EXPLAIN_ACTIVE:
  │     └── Reply "Sabar ya, lagi diproses nih... ⏳" (Drop duplicate action)
  ├── ELSE IF state is AWAITING_ANSWER:
  │     └── Route to handleHint() (Question remains locked)
  └── ELSE:
        └── Accept material and present action choice (Quiz vs Explain)
```

### Workflow 2: Model Inference & Failover
```text
IF ask(prompt, systemPrompt, options) is called:
  ├── Attempt execution with PRIMARY_MODEL (deepseek-v4.1-flash:free)
  ├── IF primary call succeeds:
  │     └── Return response string
  └── IF primary call fails (timeout, rate limit, network drop):
        ├── IF FALLBACK_MODEL is configured and distinct:
        │     ├── Log warning with error reason
        │     └── Attempt execution with FALLBACK_MODEL (mimo-v2.6-flash:free)
        │           ├── IF fallback succeeds: Return response string
        │           └── IF fallback fails: Throw error to caller
        └── ELSE:
              └── Throw error to caller
```

### Workflow 3: Quiz JSON Extraction & Repair
```text
IF parsing raw LLM response for Quiz MCQ:
  ├── Step 1: Strip leading/trailing markdown code fences
  ├── Step 2: Attempt standard JSON.parse()
  ├── IF JSON.parse() succeeds: Proceed to schema validation
  └── IF JSON.parse() throws SyntaxError:
        ├── Find first '{' and last '}'
        ├── Strip trailing commas (e.g., replace /,\s*([}\]])/g with '$1')
        ├── Attempt JSON.parse() on repaired string
        ├── IF repair succeeds: Proceed to schema validation
        └── IF repair fails:
              └── Retry 1 time with strict JSON reminder prompt
```

### Workflow 4: Telegram Message Delivery
```text
IF sendSmart(bot, chatId, text, options) is called:
  ├── Convert LaTeX commands and math syntax into Unicode equivalents
  ├── Attempt bot.sendMessage(chatId, safeText, { parse_mode: 'Markdown' })
  ├── IF Telegram delivers successfully: Complete
  └── IF Telegram rejects formatting (HTTP 400 Bad Request):
        └── Strip formatting tokens (*, _, `) and send as plain text
```

---

## 4. Agent Operational Improvements (Meta-Improvement for Satir)

To serve Satir effectively, the following operational rules are permanently established:

1. **Personalization Protocol:**
   - Always acknowledge and address Satir by name across all conversations.

2. **Root-Cause Investigation Over Superficial Guessing:**
   - When inference appears slow or times out, never guess that network or compute alone is at fault without verifying model prompt adherence. Inspect whether the model drifted into solving the problem or writing long derivations.

3. **Task-Specific Token Budgeting:**
   - Single-question quiz generation must remain strictly capped at 800–1200 max tokens to prevent runaway output.
   - Conceptual explanations can use up to 2500 max tokens.
   - Hints must remain capped at 400 max tokens.

4. **Strict Context & Language Separation:**
   - Developer communication with Satir must be in clear English.
   - End-user facing bot responses must remain in natural, casual Indonesian (*Bahasa Indonesia santai*).

5. **Antislop Code & Comment Hygiene:**
   - Eliminate decorative banners (`// =====`, `// ----`), workflow narrations, and signature echoes.
   - Retain only comments explaining constraints, protocol quirks, and non-obvious behaviors.
