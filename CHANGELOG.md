# Changelog

All notable changes to GampangBot are documented in this file.
This project adheres to Semantic Versioning.

## [v1.0.0d] - 2026-11-08

### Security & Hardening
- **Admin Panel Header Spoofing Fix:** Hardened `getClientIp` in `panel.js` to only trust `X-Forwarded-For` under explicit proxy flags (`TRUST_PROXY=true`), test environments, or loopback interfaces, preventing IP-spoofing brute-force rate limit bypasses.
- **LLM Token Drain Protection:** Enforced `MAX_HINTS_PER_QUIZ = 2` cap and input truncation (500 chars) on `handleHint` in `bot.js`, with in-flight concurrency locks to prevent API token exhaustion attacks.
- **Group Chat State Isolation & Anti-Hijacking:** Attached `quizUserId` to active quizzes; blocked other group members from hijacking answer buttons (`ANS_*`) and silenced unsolicited background group chatter from invoking LLM hint calls.
- **SSRF DNS Rebinding Prevention:** Added asynchronous pre-flight DNS resolution checks via `dns.lookup` in `providers.js` and blocked dangerous DNS rebinding domains (`.nip.io`, `.sslip.io`, `.local`, `.internal`) prior to provider probe calls.
- **Image Download OOM Guard:** Set a strict 5MB payload ceiling (`MAX_IMAGE_BYTES`) on `downloadTelegramImageAsBase64` via `Content-Length` inspection and buffer size checks to eliminate Out-Of-Memory denial-of-service risks.
- **TOCTOU Quota Reservation:** Introduced in-flight quota reservations (`reserveQuota`, `releaseQuota`) in `store.js` across quiz, explain, and image operations to prevent concurrent quota bypassing.

## [v1.0.0c] - 2026-11-08

### Added
- **Multi-Language Support (i18n):**
  - Full bilingual support with English set as default (`'en'`) and optional casual Bahasa Indonesia (`'id'`).
  - `/language` interactive command with inline buttons (`[ 🇬🇧 English ]` and `[ 🇮🇩 Bahasa Indonesia ]`).
  - Registered `/language` command in Telegram bot command menu shortcuts (`setMyCommands`).
  - Central `i18n.js` dictionary and prompt generators ensuring all UI feedback and LLM outputs (quizzes, explanations, clues) follow the user's active language.
  - Per-user language persistence stored in `data/users.json` via `store.js` (`getUserLanguage`, `setUserLanguage`).
- **Token & Response Caching:**
  - Zero-dependency in-memory LRU/TTL cache (`cache.js`) with SHA-256 content hashing to avoid redundant LLM calls and reduce API costs.
  - Upstream prompt caching support in `llm.js` (Anthropic ephemeral cache headers, static prefix structure, and completion cached token usage metrics).
  - Estimated token savings metrics tracked live in cache stats.

## [v1.0.0b] - 2026-11-06

### Security & Hardening
- Async scrypt password verification and brute-force IP rate limiting (Issue 3).
- SSRF protection on AI provider base URLs with private IP & cloud metadata blocking (Issue 4).
- DOM XSS remediation across dashboard action buttons using data attributes and HTML entity escaping (Issue 5).

## [v1.0.0a] - 2026-11-06

### Fixed
- Quota accounting across explanation requests: mapped accounting directly to user ID rather than chat ID.
- Telegram explanation routing: added `/explain`, `/jelasin`, and `/jelaskan` commands alongside prefix pattern matching for direct conceptual tutor queries.
- Users & Quota panel governance: implemented Premium subscription revocation, custom daily limit clearing back to defaults, zero-quota support, and live quota resets with UI toast notifications.
- Multi-process persistence sync: added file modification time tracking in store to sync live disk state seamlessly across concurrent processes.

## [v1.0.0] - 2026-11-04

### Highlights
- Embedded local Admin Panel (`localhost:5050`) with password authentication.
- Dynamic AI multi-provider fallback engine with automatic quarantine and health checks.
- Dual compatibility with OpenAI and Anthropic API protocols.
- Multimodal AI vision capability filtering.
- Direct user messaging and throttled Telegram broadcast engine.
- Zero-dependency PKZIP backup download and automated scheduling.

### Labels & Features

#### [Added] - Admin Panel & Authentication
- Embedded HTTP web server on port 5050 (`process.env.PANEL_PORT || 5050`) using Node.js built-in `http` module.
- Password protection with a strong default `123456` on fresh install, changeable directly from the admin dashboard.
- Cryptographically secure session management with token-based cookie authentication.
- Responsive, high-contrast dark slate dashboard UI compliant with WCAG AA accessibility standards.
- Full keyboard navigation and clean semantic structure with zero external frontend libraries.

#### [Added] - Dynamic AI Provider Management & Fallback
- Dynamic provider configuration stored in `data/providers.json`, auto-seeded from environment variables.
- Priority-based fallback execution chain: Provider 1 -> Provider 2 -> Provider 3.
- Full support for both OpenAI-compatible endpoints (`/chat/completions`) and Anthropic-compatible endpoints (`/messages`).
- Multimodal vision support indicator (`supportsVision`): automatic routing of image requests only to vision-capable models.
- Automated hourly health check probes with a 1-hour quarantine (`disabledUntil`) for failing APIs.
- Manual test probe button in the admin interface providing real-time latency feedback in milliseconds.

#### [Added] - User & Quota Governance
- User overview table with search and filtering by Telegram User ID.
- Customizable daily quota limits from 1 to infinity for both global defaults and per-user custom overrides.
- Quota management allowing atomic resets for quiz, explanation, or image upload limits.
- Premium subscription management with duration extensions and Jakarta time zone expiration display.
- Safe user record deletion with atomic persistence to `data/users.json`.

#### [Added] - Messaging & Broadcast System
- Direct messaging utility to send custom formatted notifications to individual Telegram users.
- Broadcast engine to dispatch announcements to all registered users with an enforced 60ms inter-message delay to adhere to Telegram rate limits.
- Fault-tolerant broadcasting that catches blocked or inactive user errors without halting the transmission queue.

#### [Added] - Zero-Dependency Backup & Recovery
- One-click binary `.zip` archive download via `GET /api/backup/download`.
- PKZIP generator bundling `users.json`, `providers.json`, `panel_config.json`, and dynamic `metadata.json`.
- Scheduled daily backup at 05:00 UTC with automated delivery to the administrator's Telegram chat.
- Manual `/backup` Telegram bot command for authorized administrators.

#### [Changed] - Core Architecture & System Resilience
- Decoupled `llm.js` from single-provider static configuration into dynamic fallback runner.
- Retained JSON self-repair pipelines and truncation recovery mechanisms.
- 30-minute idle memory cleanup for chat states and visual buffers.
- Dual-port architecture: port 3000 for cloud health checks and port 5050 for administration.
