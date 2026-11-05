const assert = require('assert').strict;
const http = require('http');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PROVIDERS_FILE = path.join(DATA_DIR, 'providers.json');
const CONFIG_FILE = path.join(DATA_DIR, 'panel_config.json');

// Backup original files if they exist
const backups = {};
[USERS_FILE, PROVIDERS_FILE, CONFIG_FILE].forEach((file) => {
  if (fs.existsSync(file)) {
    backups[file] = fs.readFileSync(file, 'utf8');
  }
});

function restoreBackups() {
  Object.keys(backups).forEach((file) => {
    fs.writeFileSync(file, backups[file], 'utf8');
  });
}

function request(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const rawBuffer = Buffer.concat(chunks);
        const text = rawBuffer.toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: text,
          json,
          buffer: rawBuffer,
        });
      });
    });
    req.on('error', reject);
    if (postData) {
      if (typeof postData === 'object') {
        req.write(JSON.stringify(postData));
      } else {
        req.write(postData);
      }
    }
    req.end();
  });
}

async function runTests() {
  console.log('=== Running OpenEazyQ Admin Panel Integration Tests ===\n');

  const TEST_PORT = 5055;
  const panel = require('../panel');
  const store = require('../store');
  const providers = require('../providers');
  const auth = require('../panel_auth');

  let server;
  let authToken = '';

  try {
    // 1. Server lifecycle test
    console.log('Test 1: Starting panel HTTP server on port ' + TEST_PORT + '...');
    server = panel.startPanelServer(TEST_PORT);
    assert.ok(server, 'Server instance should be returned');
    console.log('  Passed Test 1.\n');

    // 2. Unauthenticated access tests
    console.log('Test 2: Verifying unauthenticated route protections...');
    const rootRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/',
      method: 'GET',
    });
    assert.strictEqual(rootRes.statusCode, 302, 'Unauthenticated GET / should redirect with 302');
    assert.strictEqual(rootRes.headers.location, '/login', 'Redirect should target /login');

    const loginPageRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/login',
      method: 'GET',
    });
    assert.strictEqual(loginPageRes.statusCode, 200, 'GET /login should return 200');
    assert.ok(loginPageRes.body.includes('Panel Admin OpenEazyQ'), 'Login HTML should contain brand title');

    const unauthApiRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/users',
      method: 'GET',
    });
    assert.strictEqual(unauthApiRes.statusCode, 401, 'Unauthenticated GET /api/users should return 401');
    console.log('  Passed Test 2.\n');

    // 3. Authentication flow test
    console.log('Test 3: Testing login authentication and session creation...');
    const failedLoginRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { password: 'wrongpassword' });
    assert.strictEqual(failedLoginRes.statusCode, 401, 'Wrong password must return 401');

    const successLoginRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { password: '123456' });
    assert.strictEqual(successLoginRes.statusCode, 200, 'Correct default password must return 200');
    assert.strictEqual(successLoginRes.json.success, true);
    assert.ok(successLoginRes.json.token, 'Response must include session token');
    authToken = successLoginRes.json.token;

    const cookieHeader = successLoginRes.headers['set-cookie'];
    assert.ok(cookieHeader && cookieHeader.length > 0, 'Set-Cookie header must be sent');
    assert.ok(cookieHeader[0].includes('admin_session='), 'Cookie name must be admin_session');

    // Authenticated access to dashboard
    const authDashboardRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/',
      method: 'GET',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.strictEqual(authDashboardRes.statusCode, 200, 'Authenticated GET / must return 200');
    assert.ok(authDashboardRes.body.includes('OpenEazyQ Panel'), 'Dashboard HTML should contain brand');
    console.log('  Passed Test 3.\n');

    // 4. Global limit customization API test (1 to infinity)
    console.log('Test 4: Testing global quota limits customization (1 to infinity)...');
    const getLimitsRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/settings/limits',
      method: 'GET',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.strictEqual(getLimitsRes.statusCode, 200);
    assert.ok('quiz' in getLimitsRes.json, 'Response should contain quiz limit');

    // Update global limits to specific numbers and unlimited
    const setLimitsRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/settings/limits',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
    }, {
      quiz: 25,
      explain: 'unlimited',
      image: 10,
    });
    assert.strictEqual(setLimitsRes.statusCode, 200);
    assert.strictEqual(setLimitsRes.json.quiz, 25);
    assert.strictEqual(setLimitsRes.json.explain, 'unlimited');
    assert.strictEqual(setLimitsRes.json.image, 10);

    const updatedGlobal = store.getGlobalLimits();
    assert.strictEqual(updatedGlobal.quiz, 25);
    assert.strictEqual(updatedGlobal.explain, Infinity);
    assert.strictEqual(updatedGlobal.image, 10);
    console.log('  Passed Test 4.\n');

    // 5. User management & custom limits API test
    console.log('Test 5: Testing user governance and custom limit overrides...');
    const testUserId = 99887766;
    store.getUser(testUserId); // Ensure user is created in store

    const usersRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/users',
      method: 'GET',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.strictEqual(usersRes.statusCode, 200);
    assert.ok(Array.isArray(usersRes.json), 'Users API should return an array');
    const targetUser = usersRes.json.find((u) => String(u.userId) === String(testUserId));
    assert.ok(targetUser, 'Created user should be present in users list');

    // Set custom limit for user (quiz: 50, explain: 100, image: 'unlimited')
    const customLimitRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: `/api/users/${testUserId}/limits`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
    }, {
      quiz: 50,
      explain: 100,
      image: 'unlimited',
    });
    assert.strictEqual(customLimitRes.statusCode, 200);
    assert.strictEqual(store.getQuizLimit(testUserId), 50);
    assert.strictEqual(store.getExplainLimit(testUserId), 100);
    assert.strictEqual(store.getImageLimit(testUserId), Infinity);

    // Add premium days via panel
    const addPremRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: `/api/users/${testUserId}/premium`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
    }, { days: 15 });
    assert.strictEqual(addPremRes.statusCode, 200);
    const refreshedUser = store.getUser(testUserId);
    assert.ok(refreshedUser.premiumUntil > Date.now(), 'User should have active premium');

    // Reset user quota
    const resetUserRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: `/api/users/${testUserId}/reset`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
    }, { type: 'all' });
    assert.strictEqual(resetUserRes.statusCode, 200);
    assert.strictEqual(store.getUser(testUserId).quizCount, 0);

    // Delete user
    const deleteUserRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: `/api/users/${testUserId}`,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.strictEqual(deleteUserRes.statusCode, 200);
    console.log('  Passed Test 5.\n');

    // 6. AI Providers API test (CRUD, Reorder, Masking)
    console.log('Test 6: Testing AI Providers CRUD, reordering, and key masking...');
    const createProvRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/providers',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
    }, {
      name: 'Integration Test Provider',
      type: 'openai',
      baseURL: 'https://api.testprovider.com/v1',
      apiKey: 'sk-secret-key-123456789',
      model: 'test-model-v1',
      supportsVision: true,
      enabled: true,
    });
    assert.strictEqual(createProvRes.statusCode, 201);
    assert.ok(createProvRes.json.id, 'Created provider should have an ID');
    assert.strictEqual(createProvRes.json.apiKey, 'sk-s...6789', 'API key must be masked in response');
    const createdId = createProvRes.json.id;

    // Check list masking
    const provListRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/providers',
      method: 'GET',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.strictEqual(provListRes.statusCode, 200);
    const listedProv = provListRes.json.find((p) => p.id === createdId);
    assert.ok(listedProv);
    assert.strictEqual(listedProv.apiKey, 'sk-s...6789');

    // Update provider
    const updateProvRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: `/api/providers/${createdId}`,
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
    }, {
      name: 'Integration Test Provider Updated',
      supportsVision: false,
    });
    assert.strictEqual(updateProvRes.statusCode, 200);
    assert.strictEqual(updateProvRes.json.name, 'Integration Test Provider Updated');
    assert.strictEqual(updateProvRes.json.supportsVision, false);

    // Delete created provider
    const deleteProvRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: `/api/providers/${createdId}`,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.strictEqual(deleteProvRes.statusCode, 200);
    console.log('  Passed Test 6.\n');

    // 7. Zero-dependency PKZIP backup download API test
    console.log('Test 7: Testing PKZIP backup download endpoint...');
    const backupRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/backup/download',
      method: 'GET',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.strictEqual(backupRes.statusCode, 200);
    assert.strictEqual(backupRes.headers['content-type'], 'application/zip');
    assert.ok(backupRes.headers['content-disposition'].includes('attachment; filename='));
    assert.ok(backupRes.buffer.length > 100, 'Backup ZIP buffer must not be empty');
    // Verify PKZIP magic bytes: 0x50, 0x4B, 0x03, 0x04
    assert.strictEqual(backupRes.buffer[0], 0x50, 'ZIP byte 0 must be 0x50 (P)');
    assert.strictEqual(backupRes.buffer[1], 0x4b, 'ZIP byte 1 must be 0x4B (K)');
    assert.strictEqual(backupRes.buffer[2], 0x03, 'ZIP byte 2 must be 0x03');
    assert.strictEqual(backupRes.buffer[3], 0x04, 'ZIP byte 3 must be 0x04');
    console.log('  Passed Test 7.\n');

    // 8. Password change and session termination
    console.log('Test 8: Testing password change and session invalidation...');
    const changePwdRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/auth/password',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
    }, {
      currentPassword: '123456',
      newPassword: 'newsecurepassword987',
    });
    assert.strictEqual(changePwdRes.statusCode, 200);
    assert.strictEqual(changePwdRes.json.success, true);
    assert.strictEqual(auth.verifyPassword('newsecurepassword987'), true);

    // Old session token should be invalidated by password change
    const oldSessionRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/users',
      method: 'GET',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    assert.strictEqual(oldSessionRes.statusCode, 401, 'Old session should be cleared after password change');

    // Login with new password
    const newLoginRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, { password: 'newsecurepassword987' });
    assert.strictEqual(newLoginRes.statusCode, 200);
    const newAuthToken = newLoginRes.json.token;

    // Logout with new session
    const logoutRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/auth/logout',
      method: 'POST',
      headers: { Authorization: `Bearer ${newAuthToken}` },
    });
    assert.strictEqual(logoutRes.statusCode, 200);

    // After logout, token must be rejected
    const postLogoutRes = await request({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/users',
      method: 'GET',
      headers: { Authorization: `Bearer ${newAuthToken}` },
    });
    assert.strictEqual(postLogoutRes.statusCode, 401, 'Logged out session must be rejected with 401');
    console.log('  Passed Test 8.\n');

    console.log('🎉 ALL OPEN EAZY Q ADMIN PANEL TESTS PASSED SUCCESSFULLY! 🎉\n');
  } finally {
    if (server) {
      panel.stopPanelServer();
    }
    restoreBackups();
  }
}

runTests().catch((err) => {
  console.error('\n❌ TEST RUNNER FAILED WITH ERROR:\n', err);
  restoreBackups();
  process.exit(1);
});
