# Changelog

All notable changes to GampangBot are documented in this file.
This project adheres to Semantic Versioning.

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
- Password protection with default `123456`, changeable directly from the admin dashboard.
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
