const http = require('http');
const path = require('path');
const auth = require('./panel_auth');
const providers = require('./providers');
const store = require('./store');
const backup = require('./backup');
const bot = require('./bot');

const DEFAULT_PORT = process.env.PANEL_PORT ? parseInt(process.env.PANEL_PORT, 10) : 5050;

let serverInstance = null;

function parseJsonBody(req, limitBytes = 1048576) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limitBytes) {
        req.destroy();
        reject(new Error('Payload too large (maximum 1MB)'));
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON format in request body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end(JSON.stringify(data));
}

function maskApiKey(key) {
  if (!key || typeof key !== 'string') return '';
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '********';
  return trimmed.slice(0, 4) + '...' + trimmed.slice(-4);
}

function getLoginHtml(errorMessage = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenEazyQ Admin Panel | Sign In</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: #09090b;
      color: #fafafa;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
      -webkit-font-smoothing: antialiased;
    }
    .login-container {
      width: 100%;
      max-width: 420px;
    }
    .brand-header {
      text-align: center;
      margin-bottom: 2rem;
    }
    .brand-title {
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: -0.025em;
      color: #fafafa;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }
    .brand-badge {
      background: #27272a;
      border: 1px solid #3f3f46;
      color: #a1a1aa;
      font-size: 0.75rem;
      padding: 0.2rem 0.5rem;
      border-radius: 9999px;
      font-weight: 500;
    }
    .brand-subtitle {
      font-size: 0.875rem;
      color: #71717a;
      margin-top: 0.5rem;
    }
    .card {
      background: #111115;
      border: 1px solid #27272a;
      border-radius: 10px;
      padding: 2rem;
      box-shadow: 0 10px 30px -10px rgba(0, 0, 0, 0.5);
    }
    .alert {
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #fca5a5;
      padding: 0.75rem 1rem;
      border-radius: 6px;
      font-size: 0.875rem;
      margin-bottom: 1.25rem;
    }
    .field {
      margin-bottom: 1.25rem;
    }
    label {
      display: block;
      font-size: 0.875rem;
      font-weight: 500;
      color: #d4d4d8;
      margin-bottom: 0.5rem;
    }
    input {
      width: 100%;
      padding: 0.75rem 1rem;
      background: #18181f;
      border: 1px solid #27272a;
      border-radius: 6px;
      color: #fafafa;
      font-size: 0.95rem;
      min-height: 44px;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    input:focus {
      outline: none;
      border-color: #3b82f6;
      box-shadow: 0 0 0 1px #3b82f6;
    }
    button.btn-submit {
      width: 100%;
      background: #2563eb;
      color: #ffffff;
      font-weight: 600;
      border: none;
      border-radius: 6px;
      padding: 0.75rem 1rem;
      font-size: 0.95rem;
      min-height: 44px;
      cursor: pointer;
      transition: background 0.15s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }
    button.btn-submit:hover {
      background: #1d4ed8;
    }
    button.btn-submit:focus-visible {
      outline: 2px solid #60a5fa;
      outline-offset: 2px;
    }
    .footer-note {
      text-align: center;
      font-size: 0.8rem;
      color: #52525b;
      margin-top: 1.5rem;
    }
  </style>
</head>
<body>
  <div class="login-container">
    <div class="brand-header">
      <div class="brand-title">
        <span>Panel Admin OpenEazyQ</span>
        <span class="brand-badge">v1.0.0</span>
      </div>
      <p class="brand-subtitle">Enter administrator password to access console</p>
    </div>

    <main class="card">
      ${errorMessage ? `<div class="alert" role="alert">${errorMessage}</div>` : ''}
      <form method="POST" action="/api/auth/login" id="loginForm">
        <div class="field">
          <label for="password">Administrator Password</label>
          <input type="password" id="password" name="password" required autocomplete="current-password" autofocus placeholder="Default: 123456">
        </div>
        <button type="submit" class="btn-submit" id="submitBtn">Sign In to Console</button>
      </form>
    </main>

    <div class="footer-note">
      Open Source Assistant Engine for OpenEazyQ and GampangBot
    </div>
  </div>

  <script>
    const form = document.getElementById('loginForm');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pwd = document.getElementById('password').value;
      const btn = document.getElementById('submitBtn');
      btn.disabled = true;
      btn.textContent = 'Verifying credentials...';
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pwd })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          window.location.href = '/';
        } else {
          alert(data.error || 'Invalid password.');
          btn.disabled = false;
          btn.textContent = 'Sign In to Console';
        }
      } catch (err) {
        alert('Network connection error. Please try again.');
        btn.disabled = false;
        btn.textContent = 'Sign In to Console';
      }
    });
  </script>
</body>
</html>`;
}

function getDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenEazyQ Panel | Administrator Console</title>
  <style>
    :root {
      --bg: #09090b;
      --card-bg: #111115;
      --surface-hover: #18181f;
      --border: #27272a;
      --border-subtle: rgba(255, 255, 255, 0.08);
      --text: #fafafa;
      --text-muted: #a1a1aa;
      --text-dim: #71717a;
      --accent: #2563eb;
      --accent-hover: #1d4ed8;
      --focus-ring: #3b82f6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      -webkit-font-smoothing: antialiased;
    }
    header {
      background: var(--card-bg);
      border-bottom: 1px solid var(--border);
      padding: 0.85rem 1.5rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1rem;
      position: sticky;
      top: 0;
      z-index: 40;
    }
    .brand-wrap {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .brand {
      font-size: 1.15rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }
    .brand-badge {
      background: #27272a;
      border: 1px solid #3f3f46;
      color: #a1a1aa;
      font-size: 0.7rem;
      padding: 0.15rem 0.45rem;
      border-radius: 9999px;
      font-weight: 500;
    }
    nav {
      display: flex;
      gap: 0.35rem;
      flex-wrap: wrap;
      align-items: center;
    }
    .nav-btn {
      background: transparent;
      border: 1px solid transparent;
      color: var(--text-muted);
      padding: 0.45rem 0.85rem;
      border-radius: 6px;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      min-height: 40px;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
    }
    .nav-btn:hover {
      background: var(--surface-hover);
      color: var(--text);
    }
    .nav-btn.active {
      background: #27272a;
      border-color: #3f3f46;
      color: #ffffff;
      font-weight: 600;
    }
    .nav-btn:focus-visible, .btn:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible {
      outline: 2px solid var(--focus-ring);
      outline-offset: 2px;
    }
    .logout-btn {
      background: #18181f;
      border: 1px solid var(--border);
      color: #d4d4d8;
      padding: 0.45rem 0.85rem;
      border-radius: 6px;
      font-size: 0.875rem;
      cursor: pointer;
      min-height: 40px;
      transition: all 0.15s ease;
    }
    .logout-btn:hover {
      background: #27272a;
      color: #ffffff;
    }
    main {
      flex: 1;
      padding: 1.75rem 1.5rem;
      max-width: 1200px;
      width: 100%;
      margin: 0 auto;
    }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .stat-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.25rem;
    }
    .stat-label {
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
      margin-bottom: 0.5rem;
      font-weight: 600;
    }
    .stat-val {
      font-size: 1.85rem;
      font-weight: 700;
      letter-spacing: -0.03em;
      color: var(--text);
      font-variant-numeric: tabular-nums;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.25rem;
      margin-bottom: 1.5rem;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 0.75rem;
      margin-bottom: 1rem;
    }
    .card-title {
      font-size: 1.1rem;
      font-weight: 600;
      letter-spacing: -0.01em;
      color: var(--text);
    }
    .card-desc {
      font-size: 0.875rem;
      color: var(--text-muted);
      margin-bottom: 1rem;
      line-height: 1.5;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0.5rem 1rem;
      border-radius: 6px;
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      min-height: 40px;
      transition: background 0.15s ease, border-color 0.15s ease;
      text-decoration: none;
      gap: 0.4rem;
    }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-secondary {
      background: #18181f;
      border-color: var(--border);
      color: #e4e4e7;
    }
    .btn-secondary:hover {
      background: #27272a;
      color: #ffffff;
    }
    .btn-danger {
      background: rgba(239, 68, 68, 0.15);
      border-color: rgba(239, 68, 68, 0.3);
      color: #fca5a5;
    }
    .btn-danger:hover {
      background: rgba(239, 68, 68, 0.25);
      color: #ffffff;
    }
    .btn-sm {
      min-height: 32px;
      padding: 0.25rem 0.6rem;
      font-size: 0.8rem;
    }
    .search-bar-wrap {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    .search-input-wrap {
      position: relative;
      display: inline-flex;
      align-items: center;
    }
    .search-input {
      padding: 0.4rem 0.75rem;
      background: #18181f;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: #fafafa;
      font-size: 0.85rem;
      min-height: 36px;
      min-width: 260px;
    }
    .filter-pills {
      display: flex;
      gap: 0.35rem;
    }
    .filter-pill {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 0.75rem;
      padding: 0.25rem 0.6rem;
      border-radius: 9999px;
      cursor: pointer;
    }
    .filter-pill.active {
      background: #27272a;
      border-color: #52525b;
      color: #ffffff;
      font-weight: 600;
    }
    .table-container {
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: #0d0d11;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.875rem;
    }
    th, td {
      padding: 0.75rem 1rem;
      border-bottom: 1px solid var(--border-subtle);
    }
    th {
      background: #121217;
      color: #a1a1aa;
      font-weight: 600;
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover { background: rgba(255, 255, 255, 0.02); }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      padding: 0.2rem 0.55rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .badge-active { background: rgba(16, 185, 129, 0.15); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-quarantined { background: rgba(245, 158, 11, 0.15); color: #fde68a; border: 1px solid rgba(245, 158, 11, 0.3); }
    .badge-disabled { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border: 1px solid rgba(239, 68, 68, 0.3); }
    .badge-vision { background: rgba(14, 165, 233, 0.15); color: #7dd3fc; border: 1px solid rgba(14, 165, 233, 0.3); }
    .badge-protocol { background: #1f1f27; color: #cbd5e1; border: 1px solid #33333f; }
    .field-group {
      margin-bottom: 1.15rem;
    }
    .field-group label {
      display: block;
      font-size: 0.875rem;
      color: #d4d4d8;
      margin-bottom: 0.4rem;
      font-weight: 500;
    }
    .field-group input, .field-group select, .field-group textarea {
      width: 100%;
      padding: 0.65rem 0.85rem;
      background: #18181f;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      font-size: 0.875rem;
      min-height: 42px;
    }
    .field-group textarea {
      resize: vertical;
      line-height: 1.4;
    }
    .modal-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.75);
      backdrop-filter: blur(2px);
      align-items: center;
      justify-content: center;
      padding: 1rem;
      z-index: 100;
    }
    .modal-backdrop.open { display: flex; }
    .modal {
      background: #111115;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.5rem;
      width: 100%;
      max-width: 580px;
      max-height: 90vh;
      overflow-y: auto;
      box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.6);
    }
    .modal-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.25rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 0.75rem;
    }
    .modal-title {
      font-size: 1.15rem;
      font-weight: 600;
      color: var(--text);
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
      margin-top: 1.5rem;
    }
    .flex-row {
      display: flex;
      gap: 0.5rem;
      align-items: center;
    }
    /* LIVE PROBE TESTING MODAL */
    .probe-box {
      background: #09090b;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 1rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.825rem;
      color: #d4d4d8;
      margin-top: 1rem;
      max-height: 280px;
      overflow-y: auto;
    }
    .probe-step {
      display: flex;
      align-items: flex-start;
      gap: 0.6rem;
      margin-bottom: 0.5rem;
      line-height: 1.4;
    }
    .probe-step-icon {
      font-weight: bold;
    }
    .probe-step.pending { color: #71717a; }
    .probe-step.active { color: #60a5fa; }
    .probe-step.success { color: #4ade80; }
    .probe-step.error { color: #f87171; }
    /* TOAST NOTIFICATION */
    #toastContainer {
      position: fixed;
      bottom: 1.5rem;
      right: 1.5rem;
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      z-index: 200;
      max-width: 380px;
    }
    .toast {
      background: #18181f;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.75rem 1rem;
      color: #fafafa;
      font-size: 0.875rem;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
      animation: slideIn 0.2s ease-out;
    }
    .toast-success { border-left: 3px solid #10b981; }
    .toast-error { border-left: 3px solid #ef4444; }
    .toast-info { border-left: 3px solid #3b82f6; }
    @keyframes slideIn {
      from { transform: translateY(15px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
  </style>
</head>
<body>
  <div id="toastContainer"></div>

  <header>
    <div class="brand-wrap">
      <div class="brand">
        <span>OpenEazyQ Panel</span>
        <span class="brand-badge">v1.0.0</span>
      </div>
    </div>
    <nav>
      <button class="nav-btn active" data-tab="overview">Overview</button>
      <button class="nav-btn" data-tab="providers">AI Providers</button>
      <button class="nav-btn" data-tab="users">Users & Quotas</button>
      <button class="nav-btn" data-tab="messaging">Messaging & Broadcast</button>
      <button class="nav-btn" data-tab="settings">Settings</button>
      <button class="logout-btn" id="logoutBtn">Sign Out</button>
    </nav>
  </header>

  <main>
    <!-- TAB 1: OVERVIEW -->
    <section id="tab-overview" class="tab-content active">
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-label">Registered Users</div>
          <div class="stat-val" id="statTotalUsers">0</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Active Premium Users</div>
          <div class="stat-val" id="statPremiumUsers">0</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Active AI Providers</div>
          <div class="stat-val" id="statActiveProviders">0</div>
        </div>
        <div class="stat-card">
          <div class="stat-label">Global Daily Quiz Limit</div>
          <div class="stat-val" id="statQuizLimit">5</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title" style="margin-bottom: 0.5rem;">Quick System Actions</div>
        <div class="card-desc">Execute primary operational and maintenance tasks directly.</div>
        <div class="flex-row" style="flex-wrap: wrap;">
          <a href="/api/backup/download" class="btn btn-primary" download>Download Backup Archive (.zip)</a>
          <button class="btn btn-secondary" onclick="triggerCheckAllProviders()">Probe All Providers</button>
          <button class="btn btn-secondary" onclick="switchTab('messaging')">Compose System Broadcast</button>
        </div>
      </div>
    </section>

    <!-- TAB 2: AI PROVIDERS -->
    <section id="tab-providers" class="tab-content">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">Dynamic AI Provider Chain</div>
            <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem;">
              Priority fallback order (Provider #1 -> #2 -> #3). Quarantined models recover automatically after 1 hour.
            </div>
          </div>
          <div class="flex-row">
            <button class="btn btn-secondary btn-sm" onclick="triggerCheckAllProviders()">Check All Health</button>
            <button class="btn btn-primary btn-sm" onclick="openAddProviderModal()">+ Add Provider</button>
          </div>
        </div>

        <div style="margin-bottom: 1rem;" class="search-bar-wrap">
          <div class="search-input-wrap">
            <input type="text" id="providerSearchInput" class="search-input" placeholder="Search provider name, model, endpoint..." oninput="filterProvidersTable()">
          </div>
          <div class="filter-pills">
            <button class="filter-pill active" data-prov-filter="all" onclick="setProviderFilter('all', this)">All</button>
            <button class="filter-pill" data-prov-filter="active" onclick="setProviderFilter('active', this)">Active</button>
            <button class="filter-pill" data-prov-filter="quarantined" onclick="setProviderFilter('quarantined', this)">Quarantined</button>
          </div>
        </div>

        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Priority</th>
                <th>Provider & Model</th>
                <th>Protocol</th>
                <th>Vision</th>
                <th>Status</th>
                <th>Latency</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="providersTableBody">
              <tr><td colspan="7" style="text-align: center; color: var(--text-dim);">Loading AI providers...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- TAB 3: USERS & QUOTA -->
    <section id="tab-users" class="tab-content">
      <div class="card">
        <div class="card-header">
          <div>
            <div class="card-title">User Quotas & Membership Governance</div>
            <div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.25rem;">
              Manage daily usage quotas (quizzes, explanations, images) or grant premium subscriptions.
            </div>
          </div>
          <div class="search-bar-wrap">
            <input type="text" id="userSearchInput" class="search-input" placeholder="Search Telegram User ID..." oninput="filterUsersTable()">
            <div class="filter-pills">
              <button class="filter-pill active" data-user-filter="all" onclick="setUserFilter('all', this)">All</button>
              <button class="filter-pill" data-user-filter="premium" onclick="setUserFilter('premium', this)">Premium</button>
              <button class="filter-pill" data-user-filter="free" onclick="setUserFilter('free', this)">Free</button>
            </div>
          </div>
        </div>

        <div class="table-container">
          <table>
            <thead>
              <tr>
                <th>Telegram ID</th>
                <th>Tier</th>
                <th>Quizzes (Used / Limit)</th>
                <th>Explanations</th>
                <th>Images</th>
                <th>Premium Expiry</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="usersTableBody">
              <tr><td colspan="7" style="text-align: center; color: var(--text-dim);">Loading user records...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- TAB 4: MESSAGING -->
    <section id="tab-messaging" class="tab-content">
      <div class="card">
        <div class="card-title">Direct User Notification</div>
        <div class="card-desc">Send targeted message directly to a specific Telegram User ID.</div>
        <form id="directMsgForm" onsubmit="handleSendDirectMessage(event)">
          <div class="field-group">
            <label for="directTargetUserId">Target Telegram User ID</label>
            <input type="text" id="directTargetUserId" required placeholder="e.g. 123456789">
          </div>
          <div class="field-group">
            <label for="directMessageText">Message Content (Markdown supported)</label>
            <textarea id="directMessageText" required rows="3" placeholder="Write direct notification text..."></textarea>
          </div>
          <button type="submit" class="btn btn-primary" id="directMsgBtn">Send Direct Message</button>
        </form>
      </div>

      <div class="card">
        <div class="card-title">Mass Broadcast Announcement</div>
        <p class="card-desc">
          Dispatches announcements sequentially to all registered users with an enforced 60ms delay per recipient to prevent Telegram rate limit violations.
        </p>
        <form id="broadcastMsgForm" onsubmit="handleSendBroadcast(event)">
          <div class="field-group">
            <label for="broadcastMessageText">Broadcast Content</label>
            <textarea id="broadcastMessageText" required rows="4" placeholder="Write broadcast message for all bot users..."></textarea>
          </div>
          <button type="submit" class="btn btn-danger" id="broadcastMsgBtn">Start Mass Broadcast</button>
        </form>
        <div id="broadcastStatus" style="margin-top: 1rem; font-size: 0.875rem; color: #60a5fa;"></div>
      </div>
    </section>

    <!-- TAB 5: SETTINGS -->
    <section id="tab-settings" class="tab-content">
      <div class="card">
        <div class="card-title">Global Daily Quota Limits (1 to Infinity)</div>
        <p class="card-desc">
          Configure default free daily allowances. Enter a positive integer, or enter 'unlimited' / -1 for infinite quota.
        </p>
        <form id="limitsForm" onsubmit="handleSaveLimits(event)">
          <div class="field-group">
            <label for="limitQuiz">Daily Quiz Limit (Default: 5)</label>
            <input type="text" id="limitQuiz" required placeholder="e.g. 10 or unlimited">
          </div>
          <div class="field-group">
            <label for="limitExplain">Daily Explanation Limit (Default: 15)</label>
            <input type="text" id="limitExplain" required placeholder="e.g. 30 or unlimited">
          </div>
          <div class="field-group">
            <label for="limitImage">Daily Image Upload Limit (Default: 5)</label>
            <input type="text" id="limitImage" required placeholder="e.g. 10 or unlimited">
          </div>
          <button type="submit" class="btn btn-primary">Save Global Limits</button>
        </form>
      </div>

      <div class="card">
        <div class="card-title">Update Administrator Password</div>
        <p class="card-desc">Change the password required to log in to this administrative console.</p>
        <form id="passwordForm" onsubmit="handleChangePassword(event)">
          <div class="field-group">
            <label for="currentPassword">Current Password</label>
            <input type="password" id="currentPassword" required autocomplete="current-password">
          </div>
          <div class="field-group">
            <label for="newPassword">New Password (Minimum 4 Characters)</label>
            <input type="password" id="newPassword" required minlength="4" autocomplete="new-password">
          </div>
          <button type="submit" class="btn btn-secondary">Update Password</button>
        </form>
      </div>
    </section>
  </main>

  <!-- MODAL: ADD / EDIT PROVIDER -->
  <div class="modal-backdrop" id="providerModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title" id="modalProviderTitle">Add AI Provider</div>
        <button type="button" class="btn btn-secondary btn-sm" onclick="closeModal('providerModal')">✕</button>
      </div>
      <form id="providerForm" onsubmit="handleSaveProvider(event)">
        <input type="hidden" id="providerId">
        <div class="field-group">
          <label for="providerName">Provider Friendly Name</label>
          <input type="text" id="providerName" required placeholder="e.g. DeepSeek V4.1 Primary">
        </div>
        <div class="field-group">
          <label for="providerType">API Protocol</label>
          <select id="providerType" required>
            <option value="openai">OpenAI Compatible (/chat/completions)</option>
            <option value="anthropic">Anthropic Compatible (/messages)</option>
          </select>
        </div>
        <div class="field-group">
          <label for="providerBaseURL">Base URL Endpoint</label>
          <input type="url" id="providerBaseURL" required placeholder="https://api.openai.com/v1 or https://api.anthropic.com/v1">
        </div>
        <div class="field-group">
          <label for="providerApiKey">API Key</label>
          <input type="password" id="providerApiKey" placeholder="Leave empty to retain existing key">
        </div>
        <div class="field-group">
          <label for="providerModel">Model Identifier</label>
          <input type="text" id="providerModel" required placeholder="e.g. gpt-4o, claude-3-5-sonnet, deepseek-v4.1-flash:free">
        </div>
        <div class="field-group" style="display: flex; gap: 1.5rem; align-items: center; margin-top: 0.5rem;">
          <label style="margin: 0; display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
            <input type="checkbox" id="providerSupportsVision" style="width: auto; min-height: auto;">
            Supports Vision (Multimodal)
          </label>
          <label style="margin: 0; display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
            <input type="checkbox" id="providerEnabled" checked style="width: auto; min-height: auto;">
            Enabled
          </label>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" onclick="closeModal('providerModal')">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Provider</button>
        </div>
      </form>
    </div>
  </div>

  <!-- MODAL: LIVE PROBE TESTING PROCESS -->
  <div class="modal-backdrop" id="probeModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">Live Provider Probe Diagnostics</div>
        <button type="button" class="btn btn-secondary btn-sm" onclick="closeModal('probeModal')">✕</button>
      </div>
      <div>
        <div style="font-size: 0.9rem; font-weight: 600; color: #fafafa;" id="probeTargetTitle">Probing Target...</div>
        <div style="font-size: 0.8rem; color: var(--text-dim); margin-top: 0.2rem;" id="probeTargetMeta">Protocol & Parameters</div>

        <div class="probe-box" id="probeLogBox">
          <!-- Live steps injected here -->
        </div>

        <div style="margin-top: 1rem; display: flex; justify-content: space-between; align-items: center;">
          <span style="font-size: 0.8rem; color: var(--text-muted);" id="probeElapsedTimer">Elapsed: 0.0s</span>
          <button type="button" class="btn btn-secondary btn-sm" onclick="closeModal('probeModal')">Close</button>
        </div>
      </div>
    </div>
  </div>

  <!-- MODAL: ADD PREMIUM -->
  <div class="modal-backdrop" id="premiumModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">Extend Premium Subscription</div>
        <button type="button" class="btn btn-secondary btn-sm" onclick="closeModal('premiumModal')">✕</button>
      </div>
      <form id="premiumForm" onsubmit="handleSavePremium(event)">
        <input type="hidden" id="premiumUserId">
        <p class="card-desc">
          Add premium membership duration for User ID: <span id="premiumUserIdText" style="color: #fafafa; font-weight: 600;"></span>
        </p>
        <div class="field-group">
          <label for="premiumDays">Duration (Days)</label>
          <input type="number" id="premiumDays" min="1" max="3650" value="30" required>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-danger btn-sm" onclick="handleRevokePremium()" style="margin-right:auto;">Revoke Premium</button>
          <button type="button" class="btn btn-secondary" onclick="closeModal('premiumModal')">Cancel</button>
          <button type="submit" class="btn btn-primary">Apply Premium</button>
        </div>
      </form>
    </div>
  </div>

  <!-- MODAL: SET CUSTOM LIMIT -->
  <div class="modal-backdrop" id="customLimitModal">
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title">Custom User Quota Overrides</div>
        <button type="button" class="btn btn-secondary btn-sm" onclick="closeModal('customLimitModal')">✕</button>
      </div>
      <form id="customLimitForm" onsubmit="handleSaveCustomLimit(event)">
        <input type="hidden" id="customLimitUserId">
        <p class="card-desc">
          Configure custom daily allowance overrides for User ID: <span id="customLimitUserIdText" style="color: #fafafa; font-weight: 600;"></span>
        </p>
        <div class="field-group">
          <label for="userLimitQuiz">Quiz Daily Limit (Integer or 'unlimited')</label>
          <input type="text" id="userLimitQuiz" placeholder="Default global or unlimited">
        </div>
        <div class="field-group">
          <label for="userLimitExplain">Explanation Daily Limit (Integer or 'unlimited')</label>
          <input type="text" id="userLimitExplain" placeholder="Default global or unlimited">
        </div>
        <div class="field-group">
          <label for="userLimitImage">Image Upload Daily Limit (Integer or 'unlimited')</label>
          <input type="text" id="userLimitImage" placeholder="Default global or unlimited">
        </div>
        <div class="modal-actions">
          <button type="button" class="btn btn-danger btn-sm" onclick="handleResetUserLimitToDefault()">Reset to Global Default</button>
          <button type="button" class="btn btn-secondary" onclick="closeModal('customLimitModal')">Cancel</button>
          <button type="submit" class="btn btn-primary">Save Overrides</button>
        </div>
      </form>
    </div>
  </div>

  <script>
    let globalUsers = [];
    let globalProviders = [];
    let currentProviderFilter = 'all';
    let currentUserFilter = 'all';
    let probeTimerInterval = null;

    function showToast(message, type = 'info') {
      const container = document.getElementById('toastContainer');
      const toast = document.createElement('div');
      toast.className = 'toast toast-' + type;
      toast.innerHTML = '<span>' + escapeHtml(message) + '</span><button style=\"background:none;border:none;color:#a1a1aa;cursor:pointer;\" onclick=\"this.parentElement.remove()\">✕</button>';
      container.appendChild(toast);
      setTimeout(() => {
        if (toast.parentElement) toast.remove();
      }, 4500);
    }

    function switchTab(tabId) {
      document.querySelectorAll('.nav-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
      });
      document.querySelectorAll('.tab-content').forEach(section => {
        section.classList.toggle('active', section.id === 'tab-' + tabId);
      });
      if (tabId === 'providers') loadProvidersData();
      if (tabId === 'users') loadUsersData();
      if (tabId === 'settings') loadSettingsData();
      if (tabId === 'overview') loadOverviewData();
    }

    document.querySelectorAll('.nav-btn').forEach(btn => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    document.getElementById('logoutBtn').addEventListener('click', async () => {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    });

    function openModal(id) {
      document.getElementById(id).classList.add('open');
    }
    function closeModal(id) {
      document.getElementById(id).classList.remove('open');
      if (id === 'probeModal' && probeTimerInterval) {
        clearInterval(probeTimerInterval);
        probeTimerInterval = null;
      }
    }

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-backdrop.open').forEach(m => closeModal(m.id));
      }
    });

    async function loadOverviewData() {
      try {
        const [usersRes, provRes, limitsRes] = await Promise.all([
          fetch('/api/users').then(r => r.json()),
          fetch('/api/providers').then(r => r.json()),
          fetch('/api/settings/limits').then(r => r.json())
        ]);
        if (Array.isArray(usersRes)) {
          globalUsers = usersRes;
          document.getElementById('statTotalUsers').textContent = usersRes.length;
          document.getElementById('statPremiumUsers').textContent = usersRes.filter(u => u.isPremium).length;
        }
        if (Array.isArray(provRes)) {
          globalProviders = provRes;
          document.getElementById('statActiveProviders').textContent = provRes.filter(p => p.enabled && p.status === 'active').length;
        }
        if (limitsRes) {
          document.getElementById('statQuizLimit').textContent = limitsRes.quiz === 'unlimited' ? 'Infinity' : limitsRes.quiz;
        }
      } catch (err) {
        showToast('Failed to load overview data', 'error');
      }
    }

    async function loadProvidersData() {
      const tbody = document.getElementById('providersTableBody');
      try {
        const res = await fetch('/api/providers');
        const data = await res.json();
        globalProviders = data;
        renderProvidersTable();
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan=\"7\" style=\"text-align: center; color: #f87171;\">Failed to load AI providers.</td></tr>';
      }
    }

    function setProviderFilter(filter, el) {
      currentProviderFilter = filter;
      document.querySelectorAll('[data-prov-filter]').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
      renderProvidersTable();
    }

    function filterProvidersTable() {
      renderProvidersTable();
    }

    function renderProvidersTable() {
      const tbody = document.getElementById('providersTableBody');
      const q = (document.getElementById('providerSearchInput').value || '').trim().toLowerCase();

      let filtered = globalProviders;
      if (currentProviderFilter === 'active') {
        filtered = filtered.filter(p => p.enabled && p.status === 'active');
      } else if (currentProviderFilter === 'quarantined') {
        filtered = filtered.filter(p => p.status === 'quarantined');
      }

      if (q) {
        filtered = filtered.filter(p =>
          String(p.name).toLowerCase().includes(q) ||
          String(p.model).toLowerCase().includes(q) ||
          String(p.baseURL).toLowerCase().includes(q)
        );
      }

      if (!filtered || filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan=\"7\" style=\"text-align: center; color: var(--text-dim);\">No matching providers found.</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map((p, idx) => {
        const typeBadge = '<span class=\"badge badge-protocol\">' + (p.type === 'anthropic' ? 'Anthropic' : 'OpenAI') + '</span>';
        const visionBadge = p.supportsVision ? '<span class=\"badge badge-vision\">Vision</span>' : '<span style=\"color:#71717a; font-size:0.75rem;\">Text</span>';
        let statusBadge = '<span class=\"badge badge-active\">Active</span>';
        if (!p.enabled) statusBadge = '<span class=\"badge badge-disabled\">Disabled</span>';
        else if (p.status === 'quarantined') statusBadge = '<span class=\"badge badge-quarantined\">Quarantined</span>';

        const latencyDisplay = p.lastLatencyMs ? p.lastLatencyMs.toLocaleString() + ' ms' : '-';
        return '<tr>' +
          '<td><strong>#' + (idx + 1) + '</strong></td>' +
          '<td><div><strong>' + escapeHtml(p.name) + '</strong></div><div style=\"font-size:0.75rem; color:#a1a1aa;\">' + escapeHtml(p.model) + '</div></td>' +
          '<td>' + typeBadge + '</td>' +
          '<td>' + visionBadge + '</td>' +
          '<td>' + statusBadge + '</td>' +
          '<td>' + latencyDisplay + '</td>' +
          '<td><div class=\"flex-row\">' +
            '<button class=\"btn btn-secondary btn-sm\" data-id=\"' + escapeHtml(p.id) + '\" onclick=\"testSingleProvider(this.dataset.id)\">Test</button>' +
            '<button class=\"btn btn-secondary btn-sm\" data-id=\"' + escapeHtml(p.id) + '\" onclick=\"openEditProviderModal(this.dataset.id)\">Edit</button>' +
            (idx > 0 ? '<button class=\"btn btn-secondary btn-sm\" onclick=\"moveProviderUp(' + idx + ')\">▲</button>' : '') +
            (idx < globalProviders.length - 1 ? '<button class=\"btn btn-secondary btn-sm\" onclick=\"moveProviderDown(' + idx + ')\">▼</button>' : '') +
            '<button class=\"btn btn-danger btn-sm\" data-id=\"' + escapeHtml(p.id) + '\" onclick=\"deleteProviderItem(this.dataset.id)\">Delete</button>' +
          '</div></td>' +
        '</tr>';
      }).join('');
    }

    async function loadUsersData() {
      const tbody = document.getElementById('usersTableBody');
      try {
        const res = await fetch('/api/users');
        const data = await res.json();
        globalUsers = data;
        renderUsersTable();
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan=\"7\" style=\"text-align: center; color: #f87171;\">Failed to load users.</td></tr>';
      }
    }

    function setUserFilter(filter, el) {
      currentUserFilter = filter;
      document.querySelectorAll('[data-user-filter]').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
      renderUsersTable();
    }

    function filterUsersTable() {
      renderUsersTable();
    }

    function renderUsersTable() {
      const tbody = document.getElementById('usersTableBody');
      const q = (document.getElementById('userSearchInput').value || '').trim().toLowerCase();

      let filtered = globalUsers;
      if (currentUserFilter === 'premium') {
        filtered = filtered.filter(u => u.isPremium);
      } else if (currentUserFilter === 'free') {
        filtered = filtered.filter(u => !u.isPremium);
      }

      if (q) {
        filtered = filtered.filter(u => String(u.userId).toLowerCase().includes(q));
      }

      if (!filtered || filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan=\"7\" style=\"text-align: center; color: var(--text-dim);\">No matching users found.</td></tr>';
        return;
      }

      tbody.innerHTML = filtered.map(u => {
        const isPrem = u.isPremium;
        const statusBadge = isPrem ? '<span class=\"badge badge-active\">PREMIUM</span>' : '<span style=\"color:#a1a1aa; font-size:0.75rem;\">FREE</span>';
        const quizLimitStr = u.quizLimit === 'unlimited' ? '∞' : u.quizLimit;
        const expiryStr = isPrem ? (u.formattedJakartaExpiry || 'Active') : '-';

        return '<tr>' +
          '<td><code>' + escapeHtml(u.userId) + '</code></td>' +
          '<td>' + statusBadge + '</td>' +
          '<td>' + u.quizCount + ' / ' + quizLimitStr + '</td>' +
          '<td>' + u.explainCount + ' / ' + (u.explainLimit === 'unlimited' ? '∞' : u.explainLimit) + '</td>' +
          '<td>' + u.imageCount + ' / ' + (u.imageLimit === 'unlimited' ? '∞' : u.imageLimit) + '</td>' +
          '<td><small>' + expiryStr + '</small></td>' +
          '<td><div class=\"flex-row\">' +
            '<button class=\"btn btn-secondary btn-sm\" data-user-id=\"' + escapeHtml(u.userId) + '\" onclick=\"openPremiumModal(this.dataset.userId)\">+ Days</button>' +
            '<button class=\"btn btn-secondary btn-sm\" data-user-id=\"' + escapeHtml(u.userId) + '\" onclick=\"openCustomLimitModal(this.dataset.userId)\">Limit</button>' +
            '<button class=\"btn btn-secondary btn-sm\" data-user-id=\"' + escapeHtml(u.userId) + '\" onclick=\"resetUserQuotaItem(this.dataset.userId)\">Reset</button>' +
            '<button class=\"btn btn-danger btn-sm\" data-user-id=\"' + escapeHtml(u.userId) + '\" onclick=\"deleteUserItem(this.dataset.userId)\">Delete</button>' +
          '</div></td>' +
        '</tr>';
      }).join('');
    }

    async function loadSettingsData() {
      try {
        const res = await fetch('/api/settings/limits');
        const data = await res.json();
        if (data) {
          document.getElementById('limitQuiz').value = data.quiz === 'unlimited' ? 'unlimited' : data.quiz;
          document.getElementById('limitExplain').value = data.explain === 'unlimited' ? 'unlimited' : data.explain;
          document.getElementById('limitImage').value = data.image === 'unlimited' ? 'unlimited' : data.image;
        }
      } catch (err) {
        showToast('Failed to load global limits', 'error');
      }
    }

    async function handleSaveLimits(e) {
      e.preventDefault();
      const q = document.getElementById('limitQuiz').value.trim();
      const ex = document.getElementById('limitExplain').value.trim();
      const img = document.getElementById('limitImage').value.trim();
      try {
        const res = await fetch('/api/settings/limits', {\n          method: 'POST',\n          headers: { 'Content-Type': 'application/json' },\n          body: JSON.stringify({ quiz: q, explain: ex, image: img })\n        });
        const data = await res.json();
        if (res.ok) {
          showToast('Global daily quota limits updated successfully', 'success');
          loadSettingsData();
          loadOverviewData();
        } else {
          showToast(data.error || 'Failed to save quota limits', 'error');
        }
      } catch (err) {
        showToast('Network error while saving limits', 'error');
      }
    }

    async function handleChangePassword(e) {
      e.preventDefault();
      const cur = document.getElementById('currentPassword').value;
      const nw = document.getElementById('newPassword').value;
      try {
        const res = await fetch('/api/auth/password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword: cur, newPassword: nw })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast('Password updated successfully. Please sign in again.', 'success');
          setTimeout(() => { window.location.href = '/login'; }, 1200);
        } else {
          showToast(data.error || 'Failed to update password', 'error');
        }
      } catch (err) {
        showToast('Network error while updating password', 'error');
      }
    }

    function openAddProviderModal() {
      document.getElementById('modalProviderTitle').textContent = 'Add AI Provider';
      document.getElementById('providerId').value = '';
      document.getElementById('providerName').value = '';
      document.getElementById('providerType').value = 'openai';
      document.getElementById('providerBaseURL').value = '';
      document.getElementById('providerApiKey').value = '';
      document.getElementById('providerModel').value = '';
      document.getElementById('providerSupportsVision').checked = false;
      document.getElementById('providerEnabled').checked = true;
      openModal('providerModal');
    }

    function openEditProviderModal(id) {
      const p = globalProviders.find(item => item.id === id);
      if (!p) return;
      document.getElementById('modalProviderTitle').textContent = 'Edit AI Provider';
      document.getElementById('providerId').value = p.id;
      document.getElementById('providerName').value = p.name;
      document.getElementById('providerType').value = p.type || 'openai';
      document.getElementById('providerBaseURL').value = p.baseURL;
      document.getElementById('providerApiKey').value = '';
      document.getElementById('providerModel').value = p.model;
      document.getElementById('providerSupportsVision').checked = Boolean(p.supportsVision);
      document.getElementById('providerEnabled').checked = Boolean(p.enabled);
      openModal('providerModal');
    }

    async function handleSaveProvider(e) {
      e.preventDefault();
      const id = document.getElementById('providerId').value;
      const payload = {
        name: document.getElementById('providerName').value.trim(),
        type: document.getElementById('providerType').value,
        baseURL: document.getElementById('providerBaseURL').value.trim(),
        apiKey: document.getElementById('providerApiKey').value.trim(),
        model: document.getElementById('providerModel').value.trim(),
        supportsVision: document.getElementById('providerSupportsVision').checked,
        enabled: document.getElementById('providerEnabled').checked,
      };

      try {
        const url = id ? '/api/providers/' + id : '/api/providers';
        const method = id ? 'PUT' : 'POST';
        const res = await fetch(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok) {
          closeModal('providerModal');
          showToast('Provider configuration saved successfully', 'success');
          loadProvidersData();
        } else {
          showToast(data.error || 'Failed to save provider', 'error');
        }
      } catch (err) {
        showToast('Network error while saving provider', 'error');
      }
    }

    // LIVE TESTING PROCESS FOR PROVIDER PROBE
    async function testSingleProvider(id) {
      const p = globalProviders.find(item => item.id === id);
      const provName = p ? p.name : id;
      const provModel = p ? p.model : 'unknown';
      const provType = p ? (p.type || 'openai') : 'openai';

      document.getElementById('probeTargetTitle').textContent = 'Probing Provider: ' + provName + ' (' + provModel + ')';
      document.getElementById('probeTargetMeta').textContent = 'Protocol: ' + provType.toUpperCase() + ' | Payload: {"role":"user","content":"hello"} | Timeout: 120s';

      const logBox = document.getElementById('probeLogBox');
      logBox.innerHTML = '';

      function appendLog(text, statusClass = 'pending', icon = '•') {
        const div = document.createElement('div');
        div.className = 'probe-step ' + statusClass;
        div.innerHTML = '<span class=\"probe-step-icon\">' + icon + '</span><span>' + escapeHtml(text) + '</span>';
        logBox.appendChild(div);
        logBox.scrollTop = logBox.scrollHeight;
        return div;
      }

      openModal('probeModal');

      const startTime = Date.now();
      const timerEl = document.getElementById('probeElapsedTimer');
      timerEl.textContent = 'Elapsed: 0.0s';
      if (probeTimerInterval) clearInterval(probeTimerInterval);
      probeTimerInterval = setInterval(() => {
        const sec = ((Date.now() - startTime) / 1000).toFixed(1);
        timerEl.textContent = 'Elapsed: ' + sec + 's';
      }, 100);

      appendLog('1. Initializing probe request for ' + provName + '...', 'active', '>');
      appendLog('2. Connecting to base URL endpoint: ' + (p ? p.baseURL : '...'), 'pending', '•');
      appendLog('3. Sending payload { messages: [{ role: "user", content: "hello" }], max_tokens: 15 } with 120-second timeout deadline...', 'active', '⏳');

      try {
        const res = await fetch('/api/providers/' + id + '/test', { method: 'POST' });
        const data = await res.json();

        if (probeTimerInterval) {
          clearInterval(probeTimerInterval);
          probeTimerInterval = null;
        }

        if (data.success) {
          appendLog('4. Upstream response received successfully!', 'success', '✓');
          appendLog('5. Probe status: HTTP 200 OK | Round-trip latency: ' + data.latencyMs.toLocaleString() + ' ms', 'success', '✓');
          showToast('Provider ' + provName + ' probe succeeded (' + data.latencyMs.toLocaleString() + ' ms)', 'success');
        } else {
          appendLog('4. Upstream probe failed or returned error response:', 'error', '✕');
          appendLog('Error details: ' + (data.error || 'Unknown error'), 'error', '!');
          showToast('Provider ' + provName + ' probe failed: ' + (data.error || 'Error'), 'error');
        }
        loadProvidersData();
      } catch (err) {
        if (probeTimerInterval) {
          clearInterval(probeTimerInterval);
          probeTimerInterval = null;
        }
        appendLog('Connection failed: ' + err.message, 'error', '✕');
        showToast('Probe connection failed', 'error');
      }
    }

    async function triggerCheckAllProviders() {
      showToast('Initiating health probes for all providers (120s timeout)...', 'info');
      try {
        const res = await fetch('/api/providers/check-all', { method: 'POST' });
        const data = await res.json();
        showToast('All provider health checks finished', 'success');
        loadProvidersData();
        loadOverviewData();
      } catch (err) {
        showToast('Failed to complete provider health checks', 'error');
      }
    }

    async function moveProviderUp(idx) {
      if (idx <= 0) return;
      const ids = globalProviders.map(p => p.id);
      const temp = ids[idx];
      ids[idx] = ids[idx - 1];
      ids[idx - 1] = temp;
      await saveProviderOrder(ids);
    }

    async function moveProviderDown(idx) {
      if (idx >= globalProviders.length - 1) return;
      const ids = globalProviders.map(p => p.id);
      const temp = ids[idx];
      ids[idx] = ids[idx + 1];
      ids[idx + 1] = temp;
      await saveProviderOrder(ids);
    }

    async function saveProviderOrder(order) {
      try {
        await fetch('/api/providers/reorder', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ order })
        });
        loadProvidersData();
        showToast('Provider priority order updated', 'info');
      } catch (err) {
        showToast('Failed to update provider priority', 'error');
      }
    }

    async function deleteProviderItem(id) {
      if (!confirm('Are you sure you want to permanently delete this provider?')) return;
      try {
        const res = await fetch('/api/providers/' + id, { method: 'DELETE' });
        if (res.ok) {
          showToast('Provider deleted', 'info');
          loadProvidersData();
        } else {
          showToast('Failed to delete provider', 'error');
        }
      } catch (err) {
        showToast('Network error while deleting provider', 'error');
      }
    }

    function openPremiumModal(userId) {
      const u = globalUsers.find(item => String(item.userId) === String(userId)) || {};
      document.getElementById('premiumUserId').value = userId;
      document.getElementById('premiumUserIdText').textContent = userId + (u.isPremium ? ' (Active Premium)' : ' (Free)');
      document.getElementById('premiumDays').value = 30;
      openModal('premiumModal');
    }

    async function handleSavePremium(e) {
      e.preventDefault();
      const userId = document.getElementById('premiumUserId').value;
      const days = parseInt(document.getElementById('premiumDays').value, 10);
      try {
        const res = await fetch('/api/users/' + userId + '/premium', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ days })
        });
        if (res.ok) {
          closeModal('premiumModal');
          showToast('Added ' + days + ' premium days to user ' + userId, 'success');
          loadUsersData();
          loadOverviewData();
        } else {
          const data = await res.json().catch(() => ({}));
          showToast(data.error || 'Failed to extend premium days', 'error');
        }
      } catch (err) {
        showToast('Network error while applying premium', 'error');
      }
    }

    async function handleRevokePremium() {
      const userId = document.getElementById('premiumUserId').value;
      if (!confirm('Revoke premium subscription for user ' + userId + '?')) return;
      try {
        const res = await fetch('/api/users/' + userId + '/premium', {
          method: 'DELETE'
        });
        if (res.ok) {
          closeModal('premiumModal');
          showToast('Revoked premium for user ' + userId, 'info');
          loadUsersData();
          loadOverviewData();
        } else {
          const data = await res.json().catch(() => ({}));
          showToast(data.error || 'Failed to revoke premium', 'error');
        }
      } catch (err) {
        showToast('Network error while revoking premium', 'error');
      }
    }

    function openCustomLimitModal(userId) {
      const u = globalUsers.find(item => String(item.userId) === String(userId)) || {};
      document.getElementById('customLimitUserId').value = userId;
      document.getElementById('customLimitUserIdText').textContent = userId;
      const c = u.customLimits || {};
      document.getElementById('userLimitQuiz').value = c.quiz !== undefined ? (c.quiz === 'unlimited' ? 'unlimited' : c.quiz) : '';
      document.getElementById('userLimitExplain').value = c.explain !== undefined ? (c.explain === 'unlimited' ? 'unlimited' : c.explain) : '';
      document.getElementById('userLimitImage').value = c.image !== undefined ? (c.image === 'unlimited' ? 'unlimited' : c.image) : '';
      openModal('customLimitModal');
    }

    async function handleSaveCustomLimit(e) {
      e.preventDefault();
      const userId = document.getElementById('customLimitUserId').value;
      const payload = {
        quiz: document.getElementById('userLimitQuiz').value.trim(),
        explain: document.getElementById('userLimitExplain').value.trim(),
        image: document.getElementById('userLimitImage').value.trim(),
      };
      try {
        const res = await fetch('/api/users/' + userId + '/limits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (res.ok) {
          closeModal('customLimitModal');
          showToast('Custom limits updated for user ' + userId, 'success');
          loadUsersData();
          loadOverviewData();
        } else {
          const data = await res.json().catch(() => ({}));
          showToast(data.error || 'Failed to save user limits', 'error');
        }
      } catch (err) {
        showToast('Network error while saving user limits', 'error');
      }
    }

    async function handleResetUserLimitToDefault() {
      const userId = document.getElementById('customLimitUserId').value;
      try {
        const res = await fetch('/api/users/' + userId + '/limits', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(null)
        });
        if (res.ok) {
          closeModal('customLimitModal');
          showToast('Reset user ' + userId + ' to global limits', 'info');
          loadUsersData();
          loadOverviewData();
        } else {
          const data = await res.json().catch(() => ({}));
          showToast(data.error || 'Failed to reset user limits', 'error');
        }
      } catch (err) {
        showToast('Failed to reset user limits', 'error');
      }
    }

    async function resetUserQuotaItem(userId) {
      if (!confirm('Reset all daily usage counters for user ' + userId + ' to 0?')) return;
      try {
        const res = await fetch('/api/users/' + userId + '/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'all' })
        });
        if (res.ok) {
          showToast('User quota counters reset to 0', 'success');
          loadUsersData();
          loadOverviewData();
        } else {
          const data = await res.json().catch(() => ({}));
          showToast(data.error || 'Failed to reset user quota', 'error');
        }
      } catch (err) {
        showToast('Failed to reset user quota', 'error');
      }
    }

    async function deleteUserItem(userId) {
      if (!confirm('Are you sure you want to permanently delete user ' + userId + '?')) return;
      try {
        const res = await fetch('/api/users/' + userId, { method: 'DELETE' });
        if (res.ok) {
          showToast('User record deleted', 'info');
          loadUsersData();
          loadOverviewData();
        } else {
          const data = await res.json().catch(() => ({}));
          showToast(data.error || 'Failed to delete user', 'error');
        }
      } catch (err) {
        showToast('Network error while deleting user', 'error');
      }
    }

    async function handleSendDirectMessage(e) {
      e.preventDefault();
      const userId = document.getElementById('directTargetUserId').value.trim();
      const text = document.getElementById('directMessageText').value.trim();
      const btn = document.getElementById('directMsgBtn');
      btn.disabled = true;
      btn.textContent = 'Sending...';
      try {
        const res = await fetch('/api/messages/direct', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, text })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showToast('Direct message delivered to ' + userId, 'success');
          document.getElementById('directMessageText').value = '';
        } else {
          showToast(data.error || 'Failed to deliver message', 'error');
        }
      } catch (err) {
        showToast('Network error while sending direct message', 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Send Direct Message';
      }
    }

    async function handleSendBroadcast(e) {
      e.preventDefault();
      const text = document.getElementById('broadcastMessageText').value.trim();
      if (!confirm('Broadcast this message to ALL registered users?')) return;
      const btn = document.getElementById('broadcastMsgBtn');
      const statusDiv = document.getElementById('broadcastStatus');
      btn.disabled = true;
      btn.textContent = 'Broadcasting...';
      statusDiv.textContent = 'Broadcast in progress with safe 60ms delay per user...';
      try {
        const res = await fetch('/api/messages/broadcast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        const data = await res.json();
        if (res.ok) {
          statusDiv.textContent = 'Broadcast completed: Delivered to ' + data.sent + ' of ' + data.total + ' users (Failures: ' + data.failed + ')';
          showToast('Broadcast complete (' + data.sent + ' sent, ' + data.failed + ' failed)', 'success');
          document.getElementById('broadcastMessageText').value = '';
        } else {
          statusDiv.textContent = 'Broadcast halted: ' + (data.error || 'Unknown error');
          showToast(data.error || 'Broadcast failed', 'error');
        }
      } catch (err) {
        statusDiv.textContent = 'Network error occurred during broadcast.';
        showToast('Broadcast transmission error', 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Start Mass Broadcast';
      }
    }

    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    // Load initial view
    loadOverviewData();
  </script>
</body>
</html>`;
}

function getClientIp(req) {
  const forwarded = req && req.headers && req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return (req && req.socket && req.socket.remoteAddress) || '';
}

function handleAuthCheck(req, res) {
  const token = auth.extractSessionToken(req);
  const isValid = auth.verifySession(token);
  return sendJson(res, 200, { authenticated: isValid });
}

async function handleApi(req, res, pathname) {
  // Public auth endpoint: login
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const clientIp = getClientIp(req);
    const limit = auth.checkRateLimit(clientIp);
    if (!limit.allowed) {
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'Retry-After': String(limit.retryAfterSec),
      });
      res.end(JSON.stringify({ error: 'Too many failed login attempts. Please try again later.' }));
      return;
    }

    try {
      const body = await parseJsonBody(req);
      const valid = await auth.verifyPasswordAsync(body.password);
      if (valid) {
        auth.resetRateLimit(clientIp);
        const token = auth.createSession();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': `admin_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
        });
        res.end(JSON.stringify({ success: true, token }));
        return;
      }
      auth.recordLoginFailure(clientIp);
      return sendJson(res, 401, { error: 'Invalid password' });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Public auth endpoint: check status
  if (pathname === '/api/auth/check' && req.method === 'GET') {
    return handleAuthCheck(req, res);
  }

  // All other /api/* routes require valid session token
  const token = auth.extractSessionToken(req);
  if (!auth.verifySession(token)) {
    return sendJson(res, 401, { error: 'Unauthorized: session is invalid or has expired' });
  }

  // Logout
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    if (token) auth.deleteSession(token);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'admin_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // Change password
  if (pathname === '/api/auth/password' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const valid = await auth.verifyPasswordAsync(body.currentPassword);
      if (!valid) {
        return sendJson(res, 400, { error: 'Current password is incorrect' });
      }
      auth.changePassword(body.newPassword);
      return sendJson(res, 200, { success: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // ---------------- PROVIDERS API ----------------
  if (pathname === '/api/providers' && req.method === 'GET') {
    const list = providers.getProviders().map((p) => ({
      ...p,
      apiKey: maskApiKey(p.apiKey),
    }));
    return sendJson(res, 200, list);
  }

  if (pathname === '/api/providers' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const created = providers.addProvider(body);
      return sendJson(res, 201, { ...created, apiKey: maskApiKey(created.apiKey) });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (pathname === '/api/providers/reorder' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      const reordered = providers.reorderProviders(body.order);
      return sendJson(res, 200, reordered.map((p) => ({ ...p, apiKey: maskApiKey(p.apiKey) })));
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (pathname === '/api/providers/check-all' && req.method === 'POST') {
    try {
      const results = await providers.probeAllProviders();
      return sendJson(res, 200, results);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  const provMatch = pathname.match(/^\/api\/providers\/([^/]+)(?:\/(test))?$/);
  if (provMatch) {
    const providerId = provMatch[1];
    const isTest = provMatch[2] === 'test';

    if (isTest && req.method === 'POST') {
      try {
        const result = await providers.probeProvider(providerId);
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (req.method === 'PUT') {
      try {
        const body = await parseJsonBody(req);
        const updated = providers.updateProvider(providerId, body);
        if (!updated) return sendJson(res, 404, { error: 'Provider not found' });
        return sendJson(res, 200, { ...updated, apiKey: maskApiKey(updated.apiKey) });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (req.method === 'DELETE') {
      const deleted = providers.deleteProvider(providerId);
      if (!deleted) return sendJson(res, 404, { error: 'Provider not found' });
      return sendJson(res, 200, { success: true });
    }
  }

  // ---------------- USERS & QUOTA API ----------------
  if (pathname === '/api/users' && req.method === 'GET') {
    const usersList = store.getAllUsers();
    return sendJson(res, 200, usersList);
  }

  const userActionMatch = pathname.match(/^\/api\/users\/([^/]+)(?:\/(reset|premium|limits))?$/);
  if (userActionMatch) {
    const targetUserId = userActionMatch[1];
    const action = userActionMatch[2];

    if (action === 'reset' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const updatedUser = store.resetUserQuota(targetUserId, body.type || 'all');
        return sendJson(res, 200, updatedUser);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (action === 'premium') {
      if (req.method === 'DELETE') {
        const updatedUser = store.revokePremium(targetUserId);
        return sendJson(res, 200, updatedUser);
      }
      if (req.method === 'POST') {
        try {
          const body = await parseJsonBody(req);
          if (body && (body.revoke === true || body.days === 0 || body.days === '0')) {
            const updatedUser = store.revokePremium(targetUserId);
            return sendJson(res, 200, updatedUser);
          }
          const days = Number(body.days);
          if (isNaN(days) || days <= 0) {
            return sendJson(res, 400, { error: 'Parameter days must be a positive number' });
          }
          const updatedUser = store.addPremiumDays(targetUserId, days);
          return sendJson(res, 200, updatedUser);
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
    }

    if (action === 'limits' && req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const updatedUser = store.setUserLimits(targetUserId, body);
        return sendJson(res, 200, updatedUser);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (!action && req.method === 'DELETE') {
      const deleted = store.deleteUser(targetUserId);
      if (!deleted) return sendJson(res, 404, { error: 'User not found' });
      return sendJson(res, 200, { success: true });
    }
  }

  // ---------------- GLOBAL LIMITS SETTINGS API ----------------
  if (pathname === '/api/settings/limits') {
    if (req.method === 'GET') {
      const limits = store.getGlobalLimits();
      return sendJson(res, 200, {
        quiz: limits.quiz === Infinity ? 'unlimited' : limits.quiz,
        explain: limits.explain === Infinity ? 'unlimited' : limits.explain,
        image: limits.image === Infinity ? 'unlimited' : limits.image,
      });
    }
    if (req.method === 'POST') {
      try {
        const body = await parseJsonBody(req);
        const updated = store.setGlobalLimits(body);
        return sendJson(res, 200, {
          quiz: updated.quiz === Infinity ? 'unlimited' : updated.quiz,
          explain: updated.explain === Infinity ? 'unlimited' : updated.explain,
          image: updated.image === Infinity ? 'unlimited' : updated.image,
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
  }

  // ---------------- MESSAGING API ----------------
  if (pathname === '/api/messages/direct' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      if (!body.userId || !body.text) {
        return sendJson(res, 400, { error: 'Fields userId and text are required' });
      }
      const result = await bot.sendDirectMessage(body.userId, body.text);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (pathname === '/api/messages/broadcast' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req);
      if (!body.text || !body.text.trim()) {
        return sendJson(res, 400, { error: 'Broadcast message cannot be empty' });
      }
      const summary = await bot.broadcastMessage(body.text.trim());
      return sendJson(res, 200, summary);
    } catch (err) {
      const status = err.message && (err.message.includes('sedang berjalan') || err.message.includes('in progress')) ? 409 : 500;
      return sendJson(res, status, { error: err.message });
    }
  }

  // ---------------- BACKUP API ----------------
  if (pathname === '/api/backup/download' && req.method === 'GET') {
    try {
      const archive = backup.createBackupArchive();
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${archive.filename}"`,
        'Content-Length': archive.buffer.length,
      });
      res.end(archive.buffer);
      return;
    } catch (err) {
      return sendJson(res, 500, { error: 'Failed to create backup file: ' + err.message });
    }
  }

  if (pathname === '/api/backup/trigger' && req.method === 'POST') {
    try {
      const botInst = bot.getBotInstance ? bot.getBotInstance() : null;
      const result = await backup.performBackup(botInst);
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  return sendJson(res, 404, { error: 'API endpoint not found' });
}

function createPanelServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost:5050'));
      const pathname = parsedUrl.pathname;

      // API Routes
      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, pathname);
        return;
      }

      // Login page route
      if (pathname === '/login') {
        const token = auth.extractSessionToken(req);
        if (auth.verifySession(token)) {
          res.writeHead(302, { Location: '/' });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getLoginHtml());
        return;
      }

      // Root Dashboard Route
      if (pathname === '/' || pathname === '/index.html') {
        const token = auth.extractSessionToken(req);
        if (!auth.verifySession(token)) {
          res.writeHead(302, { Location: '/login' });
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getDashboardHtml());
        return;
      }

      // Catch-all
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
    } catch (err) {
      console.error('[Panel] Error handling HTTP request:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    }
  });

  return server;
}

function startPanelServer(port = DEFAULT_PORT) {
  if (serverInstance) {
    return serverInstance;
  }
  const server = createPanelServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`[Panel] OpenEazyQ Admin Panel web server running on http://localhost:${port}`);
  });
  serverInstance = server;
  return server;
}

function stopPanelServer() {
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
    return true;
  }
  return false;
}

module.exports = {
  createPanelServer,
  startPanelServer,
  stopPanelServer,
  getLoginHtml,
  getDashboardHtml,
  getClientIp,
};

if (require.main === module) {
  require('dotenv').config();
  startPanelServer();
}
