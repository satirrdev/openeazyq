# OpenEazyQ / GampangBot

[![Version](https://img.shields.io/badge/version-1.0.0c-blue.svg)](CHANGELOG.md)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Telegram Bot](https://img.shields.io/badge/Telegram-%40GampanginBot-2CA5E0.svg?logo=telegram&logoColor=white)](https://t.me/GampanginBot)

> **Open Source Project**  
> Live Telegram Bot: [@GampanginBot](https://t.me/GampanginBot)

This is an open source codebase powering two companion projects: **GampangBot** and **OpenEazyQ** (accessible live on Telegram at [@GampanginBot](https://t.me/GampanginBot)). While designed out-of-the-box as an exam assistant and conceptual tutor, the architecture is modular and versatile: if configured smartly, this project can readily serve as your personal assistant AI agent on Telegram.

It features an embedded standalone web administration panel, a dynamic multi-provider AI fallback engine supporting both OpenAI and Anthropic standards, multi-language internationalization (English & Indonesian), token savings caching, and an automated zero-dependency PKZIP backup system.

---

## Key Features

### 1. Telegram Bot Assistant
- **Multi-Language Support (EN & ID):** English default with easy `/language` switching to casual Bahasa Indonesia via inline buttons; all prompts, questions, hints, and explanations strictly adhere to the user's active language.
- **Intelligent Token & Response Caching:** In-memory SHA-256 LRU/TTL cache (`cache.js`) coupled with Anthropic ephemeral cache headers to cut token consumption and latency on repetitive study topics.
- **Interactive Exam Quizzes:** Generates multiple-choice quizzes on demand via `/quiz` or `/quiz <topic>` with strict JSON schema validation and automatic truncation repair.
- **Structured 3-Point Conceptual Tutor:** Delivers concise explanations covering Core Concept, Key Formula/Mechanism, and Quick Tips/Exam Traps.
- **Clean Math Rendering:** Automatically transforms LaTeX mathematical syntax into readable Unicode characters for native Telegram display.
- **Multimodal Visual Inputs:** Accepts exam problem photos and document images directly.
- **Daily Quotas and Premium Subscriptions:** Enforces daily limits on quizzes, explanations, and image uploads for free users (resetting at 00:00 Jakarta WIB), alongside an unlimited premium tier.

### 2. Embedded Admin Panel (Port 5050)
- **Local Web Interface:** Runs on `http://localhost:5050` (or `process.env.PANEL_PORT`) with zero external frontend libraries or heavy frameworks.
- **Password Protection:** Secured with a configurable password (default: `123456`) that can be updated directly from the dashboard.
- **Dynamic AI Provider Management:** Add, edit, toggle, and reorder AI model priority chains at runtime.
- **Dual API Protocol Compatibility:** Full support for both OpenAI (`/chat/completions`) and Anthropic (`/messages`) payload formats.
- **Multimodal Vision Filtering:** Detects vision-capable models. Image-based queries are automatically dispatched exclusively to models flagged with vision support.
- **Automated Health Probes and Quarantine:** Performs hourly health probes, quarantining failing providers for 1 hour, paired with a manual test probe button displaying live round-trip latency in milliseconds.
- **User and Quota Governance:** Inspect all user records, extend premium durations, reset quota counters, or delete accounts.
- **Customizable Quota Limits (1 to Infinity):** Set global free daily limits or per-user overrides for quizzes, conceptual explanations, and image uploads. Values can be set from 1 up to infinity ("unlimited" or -1).
- **Direct Messaging and Throttled Broadcasts:** Send direct messages to specific Telegram IDs or broadcast announcements across all users with an enforced 60ms delay between messages to respect Telegram rate limits.
- **One-Click Backup Download:** Instantly exports all data files (`users.json`, `providers.json`, `panel_config.json`, `metadata.json`) in a PKZIP archive.

### 3. Zero-Dependency Backup Engine
- **Standard PKZIP Format:** Created using Node.js built-in modules (`zlib` and `Buffer`) without third-party zip libraries.
- **Daily Automated 05:00 UTC Delivery:** Generates and delivers an encrypted, compressed archive directly to the administrator on Telegram every day.
- **Manual Telegram Backup Command:** Allows authorized administrators to trigger an immediate backup delivery using `/backup`.

---

## System Requirements

- Node.js version 18 or higher (Node.js v20 or v22 recommended)
- Telegram Bot Token from @BotFather
- AI API Key from OpenAI, Anthropic, TokenHarbor, OpenRouter, Groq, or any compatible provider

---

## Installation and Setup

1. **Clone the repository and install dependencies:**
   ```bash
   git clone https://github.com/username/gampangbot.git
   cd gampangbot
   npm install
   ```

2. **Configure Environment Variables:**
   Create a `.env` file in the root directory:
   ```env
   # Telegram Bot Token from @BotFather
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here

   # Telegram Admin User ID (numeric)
   ADMIN_ID=1234567890

   # Initial AI Provider Configuration (Optional, manageable in Admin Panel)
   AI_BASE_URL=https://tokenharbor.ai/v1
   AI_API_KEY=your_ai_api_key_here
   AI_MODEL_NAME=deepseek-v4.1-flash:free
   AI_FALLBACK_MODEL_NAME=mimo-v2.6-flash:free

   # Service Ports
   PORT=3000          # Cloud health check dummy port (Render / Koyeb)
   PANEL_PORT=5050    # OpenEazyQ Web Admin Panel port
   ```

3. **Start the Application:**
   ```bash
   npm start
   # or
   node index.js
   ```

---

## Admin Panel Guide

Once the service is running:
1. Open your browser and navigate to `http://localhost:5050`.
2. Enter the administrator password (default: `123456`).
3. Manage system resources across five tabs:
   - **Overview:** System summary displaying total users, active premium subscribers, and provider health.
   - **AI Providers:** Configure fallback sequences, add Anthropic or OpenAI models, toggle vision flags, and test response latencies.
   - **Users:** Search users by Telegram ID, reset daily quotas, or extend premium subscriptions.
   - **Messaging:** Send direct messages to specific chat IDs or broadcast messages to all users with live delivery tracking.
   - **Settings:** Change the login password and download the complete PKZIP backup file.

---

## Project Structure

```
gampangbot/
├── index.js          # Main entry point, initializes port 3000 and port 5050 servers
├── bot.js            # Telegram router, quiz state machine, sendSmart, and broadcast engine
├── llm.js            # Dynamic AI execution, multi-provider fallback, prompt caching, JSON repair
├── providers.js      # Dynamic provider registry, health probes, and quarantine manager
├── panel.js          # Standalone HTTP web server on port 5050 and admin dashboard UI
├── panel_auth.js     # Token session management and password hashing
├── store.js          # Atomic user quota, language settings, and premium persistence to data/users.json
├── backup.js         # Zero-dependency PKZIP generator and 05:00 UTC scheduler
├── i18n.js           # Multi-language string dictionaries (EN default, ID) and prompt factories
├── cache.js          # In-memory SHA-256 response & prompt cache with TTL and token savings tracking
├── quiz.js           # Multiple-choice quiz generator and conceptual tutor prompts
├── math.js           # Regex pipeline converting LaTeX to clean Telegram Unicode
├── data/
│   ├── users.json        # User quota and subscription records
│   ├── providers.json    # Dynamic AI provider configuration
│   └── panel_config.json # Admin panel password hash and settings
├── tests/            # Automated isolated test scripts
├── CHANGELOG.md      # Version history and feature release logs
└── README.md         # OpenEazyQ documentation
```

---

## License

This project is licensed under the MIT License.
