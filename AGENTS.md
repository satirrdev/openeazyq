# AGENTS.md — GampangBot (AI Exam Quiz Assistant)

## 1. Project Overview
GampangBot is a lightweight Telegram Bot designed to help students prepare for exams instantly. Users send study notes, syllabi, or raw text directly into the chat, and the bot generates interactive step-by-step multiple-choice quizzes along with instant answer evaluations.

**Current Phase Goal:** Validate core product utility with the first 10–20 active users at zero cost, ensuring a fast and crash-free user flow.

## 2. Tech Stack & Infrastructure
- **Runtime:** Node.js (v18+ or v20 LTS)
- **Bot Framework:** `node-telegram-bot-api` (Long Polling for local dev, Webhook for production)
- **LLM Engine:** OpenAI-compatible API via TokenHarbor / Cloudflare Workers AI
- **LLM Client:** `openai` npm package (configured with custom `baseURL`)
- **State Management:** In-Memory Map (MVP phase) or lightweight SQLite / Supabase free tier
- **Hosting Target:** Localhost (testing) -> Render.com Free Tier (deployment)

## 3. Environment Variables (.env)
Ensure the following environment variables are configured before starting the service:

TELEGRAM_BOT_TOKEN="8389589935:AAFWqSAKWKIFHf1wZJDbHTBNdWwUOZ36LBU"
AI_BASE_URL="https://api.tokenharbor.com/v1"
AI_API_KEY="thk_live_0TIh8dd353QvJbG9qwxizHcREnp9Pal-btQfvI8FvuMYTN_fbH2Zll6nGrBmq14N"
AI_MODEL_NAME="mimo-v2.6-flash:free"
PORT=3000

## 4. System Prompts & Output Schemas

### A. Quiz Generator Prompt (Role: Quiz Maker)
Triggered when a user sends study material or text notes:

You are GampangBot, an objective and concise exam quiz generator for students.
Task: Create EXACTLY 1 multiple-choice question based on the study material provided by the user.

Strict Output Rules:
1. You MUST return ONLY valid raw JSON without markdown code blocks or backticks.
2. Required JSON Schema:
{
  "question": "Pertanyaan yang menguji pemahaman konsep",
  "options": {
    "A": "Teks pilihan A",
    "B": "Teks pilihan B",
    "C": "Teks pilihan C",
    "D": "Teks pilihan D"
  },
  "correct_answer": "A",
  "explanation": "Penjelasan singkat 1-2 kalimat kenapa jawaban tersebut benar."
}
3. Difficulty: Medium (focus on understanding concepts, not rote memorization).
4. Output Language: MUST be in casual, clear Indonesian (Bahasa Indonesia santai tapi jelas), regardless of the input language.

### B. Answer Evaluator Prompt (Role: Feedback Engine)
Triggered when evaluating open-ended/short-essay answers:

You are GampangBot, a direct and helpful study assistant.
Task: Evaluate the user's answer against the question and source material.
Rules:
- All output MUST be in casual Indonesian (Bahasa Indonesia).
- Start the first sentence strictly with "BENAR!" or "KURANG TEPAT!".
- Explain why in a maximum of 2 sentences.
- Provide 1 quick memory trick or key takeaway so the user remembers it during the exam.

### C. Explain The Subje t that user learning
Triggered when user sending a text, image, or file. And user ask for explain that:

You are GampangBot, a direft and helpful study assistant.
Task: Explain the material that user sending, with **Explain Like Im 5** skill.
Rules:
- All output MUST be in casual Indonesian (Bahasa Indonesia).
- First. Start with explain step-by-step, slowly, and clear.
- Second. Then, Explain the Main or the Core, with detail. Buy still clearly and user can know that
- Last. Write a summary of what did you explain before.q

## 5. Agent Skills & Core Capabilities
1. **Text Parsing & Chunking:** Process raw text messages from Telegram and truncate overly long inputs to stay within safe token limits.
2. **Interactive Inline Keyboard Quiz:** Deliver multiple-choice options using Telegram Inline Keyboards (clickable A, B, C, D buttons) to eliminate user typing friction.
3. **Session & State Tracking:** Maintain per-user quiz states in memory (`IDLE`, `QUIZ_ACTIVE`, `AWAITING_ANSWER`) keyed by Telegram `chatId`.
4. **Graceful Error & Timeout Handling:** Wrap all LLM API calls and `JSON.parse()` executions in `try-catch` blocks with a strict 15-second timeout. If an API call fails, reply in Indonesian: "Server AI lagi sibuk nih, coba kirim ulang materi lu bentar lagi ya."

## 6. Strict Development Guardrails (Do's & Don'ts)
- **DO NOT** build custom authentication or login systems; use the native Telegram `user.id` / `chat.id` as the unique identifier.
- **DO NOT** implement payment gateways, subscriptions, or billing logic during the validation phase.
- **DO NOT** build a web-based frontend or admin dashboard; handle all operations strictly inside the Telegram chat interface.
- **DO** strip any accidental Markdown fences before parsing LLM responses.
- **DO** keep all user-facing bot messages, menus, and error alerts strictly in Indonesian.
- **DO** keep the codebase inside a single, modular directory structure (`index.js`, `.env`, `package.json`) for rapid iteration and debugging.
