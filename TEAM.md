# Multi-Agent Engineering Team Protocol — GampangBot

This document defines the autonomous Multi-Agent Engineering Team workflow for developing and maintaining the **GampangBot** project. 

The Lead Orchestrator (the primary agent session) coordinates 5 specialized subagents using the `subagent` harness tool. Every subagent operates in an isolated child session with a single responsibility, preventing context pollution and ensuring rigorous verification.

---

## 1. Team Architecture & Responsibilities

```
                          ┌──────────────────────────┐
                          │   Satir (Product Owner)  │
                          └─────────────┬────────────┘
                                        │ (Task / Feature Request)
                                        ▼
                          ┌──────────────────────────┐
                          │    Lead Orchestrator     │
                          │     (Primary Session)    │
                          └─────────────┬────────────┘
                                        │
           ┌────────────────────────────┼────────────────────────────┐
           ▼                            ▼                            ▼
┌──────────────────────┐     ┌──────────────────────┐     ┌──────────────────────┐
│ 1. RESEARCHER AGENT  │ ──► │ 2. PLANNER AGENT     │ ──► │ 3. DEVELOPER AGENT   │
│ Type: explore/general│     │ Type: general        │     │ Type: general        │
│ Task: Codebase audit,│     │ Task: Break complex  │     │ Task: Code logic,    │
│ API research, spec   │     │ tasks into bite-size │     │ handlers, state logic│
└──────────────────────┘     └──────────────────────┘     └──────────┬───────────┘
                                                                     │
                                                                     ▼
                                                          ┌──────────────────────┐
                                                          │ 4. QA / TESTER AGENT │
                                                          │ Type: general        │
                                                          │ Task: Unit tests,    │
                                                          │ mock Telegram & LLM  │
                                                          └──────────┬───────────┘
                                                                     │
                                                                     ▼
                                                          ┌──────────────────────┐
                                                          │ 5. AUDITOR AGENT     │
                                                          │ Type: general        │
                                                          │ Task: Security, leak │
                                                          │ check, anti-slop, QC │
                                                          └──────────────────────┘
```

---

## 2. Agent Definitions & Contracts

### Agent 1: Researcher Agent
- **Harness Subagent Type:** `explore` (for codebase search) or `general` (for API research/spec writing)
- **Role:** System Analyst & Feature Architect
- **Mission:** Investigate the existing codebase (`bot.js`, `quiz.js`, `llm.js`), check Telegram Bot API capabilities, review constraints, and produce an actionable Technical Specification (`spec.md` or structured report).
- **Strict Guardrails:**
  - DO NOT write production application code.
  - Deliver clear inputs, outputs, state modifications, edge cases, and architectural constraints.

### Agent 2: Planner Agent (Task Decomposer)
- **Harness Subagent Type:** `general`
- **Role:** Task Decomposition Specialist & Scrum Planner
- **Mission:** Take complex, multifaceted features or requests from Satir/Researcher and break them down into small, bite-sized, atomic, and testable sub-tasks (Task 1, Task 2, Task 3...).
- **Strict Guardrails:**
  - Each atomic task must touch only 1 or 2 specific files/functions.
  - Define explicit **Input $\rightarrow$ Output $\rightarrow$ Acceptance Criteria** for each sub-task.
  - Sequence tasks logically so that dependencies are resolved before dependent code is written.
  - Prevent scope creep: reject unnecessary abstractions or speculative refactors.

### Agent 3: Developer Agent
- **Harness Subagent Type:** `general`
- **Role:** Implementation Engineer
- **Mission:** Implement atomic tasks sequentially as defined by the Planner's breakdown.
- **Strict Guardrails:**
  - Adhere strictly to the existing codebase conventions and `AGENTS.md`.
  - Follow Anti-Slop guidelines: no redundant AI comments, no unnecessary dependencies.
  - Implement defensive error handling (try-catch, 15s-90s timeouts, safe Markdown/Unicode handling via `sendSmart()`).
  - Modify only the required files and verify syntax with `node -c <file>` before handing over.

### Agent 4: QA / Tester Agent
- **Harness Subagent Type:** `general`
- **Role:** Quality Assurance & Test Engineer
- **Mission:** Verify code correctness, robustness, and performance by writing and executing automated test scripts.
- **Strict Guardrails:**
  - Create isolated tests (e.g., `tests/test_<feature>.js`).
  - Test edge cases: malformed JSON, network dropouts, rate limits, race conditions, rapid double clicks.
  - Report concrete evidence: test commands executed, pass/fail results, and reproduction logs for any failure.
  - If a test fails, provide actionable bug details back to the Lead Orchestrator for the Developer to fix.

### Agent 5: Auditor Agent
- **Harness Subagent Type:** `general`
- **Role:** Security, Code Quality, and Compliance Reviewer
- **Mission:** Final inspection gatekeeper before shipping or marking a task complete.
- **Audit Checklist:**
  1. **Security & Secrets:** Ensure no API tokens or sensitive data are hardcoded.
  2. **Memory Leaks:** Ensure timers (`setTimeout`, `setInterval`) and event listeners are properly cleared.
  3. **Compliance with AGENTS.md:** User-facing strings must remain in casual Indonesian; JSON schemas must remain intact.
  4. **Code Quality:** Ensure no regression of entity parse errors (`sendSmart()` usage) or unhandled Promise rejections.
- **Verdict Output:** `APPROVED` or `REJECTED (with specific line numbers and remediation steps)`.

---

## 3. End-to-End Workflow Protocol

When **Satir** requests a new feature, bug fix, or refactor, the Lead Orchestrator executes this exact sequential pipeline:

```
[Phase 1: Research] ──► [Phase 2: Plan & Decompose] ──► [Phase 3: Develop] ──► [Phase 4: QA Testing] ──► [Phase 5: Audit] ──► [Report to Satir]
```

### Phase 1: Research & Discovery
1. Lead Orchestrator spawns the **Researcher Agent**.
2. Researcher inspects the codebase, external APIs, and technical constraints.
3. Researcher produces a technical finding report.

### Phase 2: Planning & Task Decomposition
1. Lead Orchestrator spawns the **Planner Agent**, providing the request and Researcher's findings.
2. Planner breaks the complex task into atomic sub-tasks with strict acceptance criteria:
   - *Example:* Task 1: Update in-memory state schema $\rightarrow$ Task 2: Add timer logic $\rightarrow$ Task 3: Handle callback expiration.
3. Planner orders them sequentially without circular dependencies.

### Phase 3: Incremental Implementation
1. Lead Orchestrator iterates through each sub-task from the Planner.
2. Spawns the **Developer Agent** for each atomic sub-task.
3. Developer implements and runs `node -c` syntax check.

### Phase 4: QA & Verification
1. Lead Orchestrator spawns the **QA / Tester Agent**.
2. QA writes test scripts, executes unit/integration checks via the shell, and records results.
3. **If QA FAILS:** Lead Orchestrator passes error logs back to the **Developer Agent** (Fix Loop, max 3 rounds) before re-testing.

### Phase 5: Audit & Review
1. Lead Orchestrator spawns the **Auditor Agent**.
2. Auditor reviews the `git diff`, checks security, anti-slop rules, and `AGENTS.md` adherence.
3. **If Auditor REJECTS:** Developer fixes the flagged issues.
4. **If Auditor APPROVES:** Lead Orchestrator cleans up temporary test files, commits changes, and reports the completed result to **Satir**.

---

## 4. How to Invoke Subagents via the Harness

The Lead Orchestrator uses the `subagent` tool with structured prompts for each phase:

### 1. Spawning Researcher
```javascript
subagent({
  agent: "general",
  description: "Research <Feature Name>",
  prompt: `You are the RESEARCHER AGENT for GampangBot.
Task: Analyze how to implement <Feature Name> for user Satir.
Review files: bot.js, quiz.js, llm.js, AGENTS.md.
Output required:
1. Technical architecture & current codebase touchpoints
2. External API or library constraints
3. Technical feasibility and edge case analysis`
})
```

### 2. Spawning Planner
```javascript
subagent({
  agent: "general",
  description: "Plan and decompose <Feature Name>",
  prompt: `You are the PLANNER AGENT for GampangBot.
Task: Decompose the complex feature <Feature Name> into bite-sized, atomic, sequential sub-tasks.
Context from Researcher:
<Insert Research Spec Here>

Output format required:
For each sub-task:
- Task ID: (e.g., Task 1, Task 2)
- Target File(s) & Function(s)
- What to implement (Clear scope, no fluff)
- Acceptance Criteria (Exact testable condition)
- Dependency: (Which task must complete first)`
})
```

### 3. Spawning Developer
```javascript
subagent({
  agent: "general",
  description: "Implement <Sub-task ID>",
  prompt: `You are the DEVELOPER AGENT for GampangBot.
Task: Implement <Sub-task ID> based on the Planner's spec:
<Insert Atomic Sub-task Here>
Rules:
- Respect AGENTS.md and keep bot messages in casual Indonesian.
- Use safe entity parsing via sendSmart().
- Verify syntax with node -c <file>.`
})
```

### 4. Spawning QA Tester
```javascript
subagent({
  agent: "general",
  description: "Test <Feature Name>",
  prompt: `You are the QA TESTER AGENT for GampangBot.
Task: Write and run automated tests for <Feature Name>.
Verify:
1. Happy path execution.
2. Edge cases (timeouts, invalid input, rapid clicks).
Run your test script and report the exact shell output and pass/fail summary.`
})
```

### 5. Spawning Auditor
```javascript
subagent({
  agent: "general",
  description: "Audit <Feature Name>",
  prompt: `You are the AUDITOR AGENT for GampangBot.
Task: Perform a strict code quality, security, and compliance audit on the latest changes.
Review:
1. No leaked credentials.
2. No memory leaks (timers and listeners cleared).
3. AGENTS.md compliance.
Verdict: APPROVED or REJECTED with clear reasons.`
})
```

---

## 5. Failure Handling & The Fix Loop

- If any stage fails, the Lead Orchestrator does NOT guess or bypass review.
- Failures are passed back to the responsible agent with the exact error output.
- Maximum 3 fix iterations per task. If unresolved after 3 attempts, escalate to Satir with concrete diagnostics.
