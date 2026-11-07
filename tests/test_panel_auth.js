const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'panel_config.json');
const TMP_FILE = path.join(DATA_DIR, 'panel_config.json.tmp');

// Track if panel_config.json existed before tests
const originalConfigExisted = fs.existsSync(CONFIG_FILE);
const originalConfigContent = originalConfigExisted ? fs.readFileSync(CONFIG_FILE, 'utf8') : null;

function cleanup() {
  try {
    if (fs.existsSync(TMP_FILE)) {
      fs.unlinkSync(TMP_FILE);
    }
  } catch (_) {}

  try {
    if (originalConfigExisted && originalConfigContent !== null) {
      fs.writeFileSync(CONFIG_FILE, originalConfigContent, 'utf8');
    } else if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
    }
  } catch (_) {}
}

async function runTests() {
  console.log('=== Running panel_auth.js Verification Tests ===\n');

  try {
    // Ensure clean state before importing
    if (fs.existsSync(CONFIG_FILE)) {
      fs.unlinkSync(CONFIG_FILE);
    }

    // Load panel_auth module
    const panelAuth = require('../panel_auth');

    // Test 1: Initialization of default password '123456'
    console.log('Test 1: Auto-initialization with default password "123456"...');
    assert.strictEqual(fs.existsSync(CONFIG_FILE), true, 'data/panel_config.json should be created upon initialization');
    const rawConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    assert.ok(rawConfig.salt, 'Config must contain salt');
    assert.ok(rawConfig.passwordHash, 'Config must contain passwordHash');
    assert.strictEqual(rawConfig.salt.length, 32, 'Salt should be 16 bytes (32 hex characters)');
    assert.strictEqual(rawConfig.passwordHash.length, 128, 'scrypt 64-byte hash should be 128 hex characters');
    console.log('  Passed Test 1.\n');

    // Test 2: verifyPassword with default password
    console.log('Test 2: verifyPassword with default and incorrect passwords...');
    assert.strictEqual(panelAuth.verifyPassword('123456'), true, 'Default password "123456" must verify as true');
    assert.strictEqual(panelAuth.verifyPassword('wrongpassword'), false, 'Incorrect password must verify as false');
    assert.strictEqual(panelAuth.verifyPassword(''), false, 'Empty string must verify as false');
    assert.strictEqual(panelAuth.verifyPassword(null), false, 'null must verify as false');
    assert.strictEqual(panelAuth.verifyPassword(undefined), false, 'undefined must verify as false');
    assert.strictEqual(panelAuth.verifyPassword(123456), false, 'Non-string must verify as false');
    console.log('  Passed Test 2.\n');

    // Test 3: Session management (createSession, verifySession, deleteSession)
    console.log('Test 3: In-memory session manager...');
    const token1 = panelAuth.createSession();
    assert.strictEqual(typeof token1, 'string', 'Token must be a string');
    assert.strictEqual(token1.length, 64, 'Token must be 32 bytes (64 hex characters)');
    assert.strictEqual(panelAuth.verifySession(token1), true, 'Active session must verify as true');
    assert.strictEqual(panelAuth.verifySession('non-existent-token'), false, 'Non-existent token must verify as false');
    assert.strictEqual(panelAuth.verifySession(''), false, 'Empty token must verify as false');
    assert.strictEqual(panelAuth.verifySession(null), false, 'null token must verify as false');

    // Test session expiration
    const tokenExp = panelAuth.createSession();
    assert.strictEqual(panelAuth.verifySession(tokenExp), true, 'Fresh token should be valid');
    // Artificially expire the session
    const sessionObj = panelAuth.sessions.get(tokenExp);
    sessionObj.expiresAt = Date.now() - 1000;
    assert.strictEqual(panelAuth.verifySession(tokenExp), false, 'Expired token must verify as false');
    assert.strictEqual(panelAuth.sessions.has(tokenExp), false, 'Expired token must be deleted from Map');

    // Test deleteSession
    const tokenToDel = panelAuth.createSession();
    assert.strictEqual(panelAuth.verifySession(tokenToDel), true);
    panelAuth.deleteSession(tokenToDel);
    assert.strictEqual(panelAuth.verifySession(tokenToDel), false, 'Deleted session must verify as false');
    console.log('  Passed Test 3.\n');

    // Test 4: changePassword
    console.log('Test 4: changePassword functionality & validation...');
    const tokenBeforeChange = panelAuth.createSession();
    assert.strictEqual(panelAuth.verifySession(tokenBeforeChange), true);

    // Validation: min length 4 and string type
    assert.throws(() => panelAuth.changePassword('123'), /at least 4 characters/, 'Should reject passwords shorter than 4 chars');
    assert.throws(() => panelAuth.changePassword(''), /at least 4 characters/, 'Should reject empty password');
    assert.throws(() => panelAuth.changePassword(null), /at least 4 characters/, 'Should reject null');
    assert.throws(() => panelAuth.changePassword(12345), /at least 4 characters/, 'Should reject number');

    // Valid password change
    const changeResult = panelAuth.changePassword('adminSuperSecret2026');
    assert.deepStrictEqual(changeResult, { success: true }, 'changePassword must return { success: true }');

    // Sessions should be cleared on password change
    assert.strictEqual(panelAuth.verifySession(tokenBeforeChange), false, 'Old sessions must be invalidated on password change');
    assert.strictEqual(panelAuth.sessions.size, 0, 'sessions Map must be emptied');

    // Password verification with new password
    assert.strictEqual(panelAuth.verifyPassword('adminSuperSecret2026'), true, 'New password must verify as true');
    assert.strictEqual(panelAuth.verifyPassword('123456'), false, 'Old default password must now verify as false');

    // Verify persistence to disk
    const updatedRaw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    assert.notStrictEqual(updatedRaw.passwordHash, rawConfig.passwordHash, 'Stored passwordHash on disk must be updated');
    console.log('  Passed Test 4.\n');

    // Test 5: extractSessionToken
    console.log('Test 5: extractSessionToken from cookies and headers...');
    assert.strictEqual(panelAuth.extractSessionToken(null), null);
    assert.strictEqual(panelAuth.extractSessionToken({}), null);
    assert.strictEqual(panelAuth.extractSessionToken({ headers: {} }), null);

    // Cookie extraction
    const reqCookieSingle = {
      headers: {
        cookie: 'admin_session=abc123token',
      },
    };
    assert.strictEqual(panelAuth.extractSessionToken(reqCookieSingle), 'abc123token', 'Should extract single cookie');

    const reqCookieMultiple = {
      headers: {
        cookie: 'theme=dark; admin_session=secret_session_token_xyz; lang=id',
      },
    };
    assert.strictEqual(panelAuth.extractSessionToken(reqCookieMultiple), 'secret_session_token_xyz', 'Should extract cookie among multiple cookies');

    // Authorization header extraction
    const reqBearer = {
      headers: {
        authorization: 'Bearer auth_bearer_token_123',
      },
    };
    assert.strictEqual(panelAuth.extractSessionToken(reqBearer), 'auth_bearer_token_123', 'Should extract Bearer token');

    const reqBearerCase = {
      headers: {
        authorization: 'bearer case_insensitive_token_456',
      },
    };
    assert.strictEqual(panelAuth.extractSessionToken(reqBearerCase), 'case_insensitive_token_456', 'Should extract case-insensitive bearer token');

    // Fallback when cookie is absent but Bearer is present
    const reqCookieNoAdmin = {
      headers: {
        cookie: 'theme=dark; lang=id',
        authorization: 'Bearer fallback_token_789',
      },
    };
    assert.strictEqual(panelAuth.extractSessionToken(reqCookieNoAdmin), 'fallback_token_789', 'Should fall back to Bearer when cookie lacks admin_session');

    // Neither valid
    const reqInvalid = {
      headers: {
        cookie: 'theme=dark; lang=id',
        authorization: 'Basic dXNlcjpwYXNz',
      },
    };
    assert.strictEqual(panelAuth.extractSessionToken(reqInvalid), null, 'Should return null when neither admin_session nor Bearer matches');
    console.log('  Passed Test 5.\n');

    // Test 6: hashPasswordAsync & verifyPasswordAsync
    console.log('Test 6: Async hashing and verification...');
    const asyncHash = await panelAuth.hashPasswordAsync('testPass123', 'staticSalt16Bytes');
    const syncHash = panelAuth.hashPassword('testPass123', 'staticSalt16Bytes');
    assert.strictEqual(asyncHash, syncHash, 'Async and sync hash results must match');
    assert.strictEqual(await panelAuth.verifyPasswordAsync('adminSuperSecret2026'), true, 'verifyPasswordAsync must return true for current password');
    assert.strictEqual(await panelAuth.verifyPasswordAsync('wrongSecret'), false, 'verifyPasswordAsync must return false for wrong password');
    assert.strictEqual(await panelAuth.verifyPasswordAsync(''), false, 'verifyPasswordAsync must return false for empty string');
    assert.strictEqual(await panelAuth.verifyPasswordAsync(null), false, 'verifyPasswordAsync must return false for null');
    console.log('  Passed Test 6.\n');

    // Test 7: In-memory IP rate limiter
    console.log('Test 7: In-memory IP rate limiter...');
    const testIp = '198.51.100.42';
    panelAuth.resetRateLimit(testIp);

    let rateCheck = panelAuth.checkRateLimit(testIp);
    assert.strictEqual(rateCheck.allowed, true);
    assert.strictEqual(rateCheck.remainingAttempts, 5);
    assert.strictEqual(rateCheck.retryAfterSec, 0);

    for (let i = 1; i <= 4; i++) {
      panelAuth.recordLoginFailure(testIp);
      rateCheck = panelAuth.checkRateLimit(testIp);
      assert.strictEqual(rateCheck.allowed, true);
      assert.strictEqual(rateCheck.remainingAttempts, 5 - i);
    }

    // 5th failure triggers lockout
    panelAuth.recordLoginFailure(testIp);
    rateCheck = panelAuth.checkRateLimit(testIp);
    assert.strictEqual(rateCheck.allowed, false);
    assert.strictEqual(rateCheck.remainingAttempts, 0);
    assert.ok(rateCheck.retryAfterSec > 0 && rateCheck.retryAfterSec <= 900);

    // resetRateLimit clears lockout
    panelAuth.resetRateLimit(testIp);
    rateCheck = panelAuth.checkRateLimit(testIp);
    assert.strictEqual(rateCheck.allowed, true);
    assert.strictEqual(rateCheck.remainingAttempts, 5);

    // Sliding window expiration
    const expireIp = '198.51.100.99';
    for (let i = 0; i < 5; i++) {
      panelAuth.recordLoginFailure(expireIp);
    }
    assert.strictEqual(panelAuth.checkRateLimit(expireIp).allowed, false);
    // Artificially age the timestamp beyond LOCKOUT_MS
    const record = panelAuth.loginFailures.get(expireIp);
    record.timestamp = Date.now() - (15 * 60 * 1000 + 1000);
    rateCheck = panelAuth.checkRateLimit(expireIp);
    assert.strictEqual(rateCheck.allowed, true, 'Expired lockout must reset allowed to true');
    assert.strictEqual(rateCheck.remainingAttempts, 5);
    console.log('  Passed Test 7.\n');

    console.log('ALL TESTS PASSED SUCCESSFULLY! 🚀');
  } finally {
    cleanup();
  }
}

runTests().catch((err) => {
  cleanup();
  console.error('Test execution failed:', err);
  process.exit(1);
});
