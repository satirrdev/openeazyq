const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const http = require('http');

async function runTests() {
  console.log('=== Running Task 3 & Task 4 (providers.js) Verification Tests ===\n');

  const DATA_DIR = path.join(__dirname, '..', 'data');
  const PROVIDERS_FILE = path.join(DATA_DIR, 'providers.json');
  const BACKUP_FILE = path.join(DATA_DIR, 'providers.json.bak_test');

  // Backup existing data/providers.json if present
  let hadOriginalFile = false;
  if (fs.existsSync(PROVIDERS_FILE)) {
    hadOriginalFile = true;
    fs.copyFileSync(PROVIDERS_FILE, BACKUP_FILE);
    fs.unlinkSync(PROVIDERS_FILE);
  }

  try {
    // -------------------------------------------------------------
    // Test 1: Automatic Seed & Initial Persistence
    // -------------------------------------------------------------
    console.log('Test 1: Automatic seed when providers.json is missing...');
    delete require.cache[require.resolve('../providers')];
    const providersModule = require('../providers');

    assert.strictEqual(fs.existsSync(PROVIDERS_FILE), true, 'providers.json must be created automatically');
    const initialProviders = providersModule.getProviders();
    assert.strictEqual(Array.isArray(initialProviders), true, 'getProviders() must return an array');
    assert.strictEqual(initialProviders.length, 2, 'Default seeded list must have exactly 2 providers');

    const primary = initialProviders[0];
    assert.strictEqual(primary.id, 'provider_primary');
    assert.strictEqual(primary.name, 'Primary AI');
    assert.strictEqual(primary.type, 'openai');
    assert.strictEqual(primary.supportsVision, true);
    assert.strictEqual(primary.enabled, true);
    assert.strictEqual(primary.status, 'active');
    assert.strictEqual(primary.lastChecked, 0);
    assert.strictEqual(primary.lastLatencyMs, 0);
    assert.strictEqual(primary.lastError, null);
    assert.strictEqual(primary.disabledUntil, 0);

    const fallback = initialProviders[1];
    assert.strictEqual(fallback.id, 'provider_fallback');
    assert.strictEqual(fallback.name, 'Fallback AI');
    assert.strictEqual(fallback.type, 'openai');
    assert.strictEqual(fallback.supportsVision, false);
    assert.strictEqual(fallback.enabled, true);
    assert.strictEqual(fallback.status, 'active');
    console.log('  Passed Test 1.\n');

    // -------------------------------------------------------------
    // Test 2: Validation on addProvider()
    // -------------------------------------------------------------
    console.log('Test 2: Validation on addProvider()...');
    assert.throws(
      () => providersModule.addProvider(null),
      /Data provider harus berupa objek/,
      'Must reject null or non-object'
    );
    assert.throws(
      () => providersModule.addProvider({ type: 'openai', baseURL: 'http://localhost', model: 'gpt-4o' }),
      /Field name wajib diisi/,
      'Must reject missing name'
    );
    assert.throws(
      () => providersModule.addProvider({ name: 'Test', type: 'invalid', baseURL: 'http://localhost', model: 'gpt-4o' }),
      /Field type wajib diisi/,
      'Must reject invalid type'
    );
    assert.throws(
      () => providersModule.addProvider({ name: 'Test', type: 'openai', model: 'gpt-4o' }),
      /Field baseURL wajib diisi/,
      'Must reject missing baseURL'
    );
    assert.throws(
      () => providersModule.addProvider({ name: 'Test', type: 'openai', baseURL: 'http://localhost' }),
      /Field model wajib diisi/,
      'Must reject missing model'
    );
    console.log('  Passed Test 2.\n');

    // -------------------------------------------------------------
    // Test 3: Happy Path addProvider()
    // -------------------------------------------------------------
    console.log('Test 3: Happy path addProvider()...');
    const added = providersModule.addProvider({
      name: 'Custom Anthropic Provider',
      type: 'anthropic',
      baseURL: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test-12345',
      model: 'claude-3-5-sonnet-20241022',
      supportsVision: true,
      enabled: true,
    });

    assert.ok(added.id.startsWith('p_'), 'Generated ID must start with p_');
    assert.strictEqual(added.name, 'Custom Anthropic Provider');
    assert.strictEqual(added.type, 'anthropic');
    assert.strictEqual(added.apiKey, 'sk-ant-test-12345');
    assert.strictEqual(added.supportsVision, true);
    assert.strictEqual(added.enabled, true);

    const afterAdd = providersModule.getProviders();
    assert.strictEqual(afterAdd.length, 3, 'Total providers should now be 3');
    assert.strictEqual(afterAdd[2].id, added.id);

    // Verify disk persistence
    const diskContent = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
    assert.strictEqual(diskContent.length, 3, 'File on disk must reflect 3 providers');
    console.log('  Passed Test 3.\n');

    // -------------------------------------------------------------
    // Test 4: updateProvider() with apiKey preservation
    // -------------------------------------------------------------
    console.log('Test 4: updateProvider() and apiKey preservation...');
    const updatedNameOnly = providersModule.updateProvider(added.id, {
      name: 'Renamed Claude Provider',
      apiKey: '', // Empty apiKey should NOT overwrite existing key
    });

    assert.strictEqual(updatedNameOnly.name, 'Renamed Claude Provider');
    assert.strictEqual(updatedNameOnly.apiKey, 'sk-ant-test-12345', 'apiKey must remain preserved when empty patch is passed');

    const updatedWithNewKey = providersModule.updateProvider(added.id, {
      apiKey: 'sk-ant-updated-999',
    });
    assert.strictEqual(updatedWithNewKey.apiKey, 'sk-ant-updated-999', 'apiKey must be updated when non-empty string is provided');

    // Non-existent provider
    const notFound = providersModule.updateProvider('p_non_existent', { name: 'X' });
    assert.strictEqual(notFound, null, 'Updating non-existent ID should return null');
    console.log('  Passed Test 4.\n');

    // -------------------------------------------------------------
    // Test 5: reorderProviders()
    // -------------------------------------------------------------
    console.log('Test 5: reorderProviders()...');
    const reordered = providersModule.reorderProviders([added.id, 'provider_fallback', 'provider_primary']);
    assert.strictEqual(reordered[0].id, added.id);
    assert.strictEqual(reordered[1].id, 'provider_fallback');
    assert.strictEqual(reordered[2].id, 'provider_primary');

    const diskReorder = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
    assert.strictEqual(diskReorder[0].id, added.id, 'Reordered state must be persisted to disk');
    console.log('  Passed Test 5.\n');

    // -------------------------------------------------------------
    // Test 6: deleteProvider()
    // -------------------------------------------------------------
    console.log('Test 6: deleteProvider()...');
    const deleteSuccess = providersModule.deleteProvider(added.id);
    assert.strictEqual(deleteSuccess, true, 'deleteProvider must return true on success');
    assert.strictEqual(providersModule.getProviders().length, 2, 'Provider count must return to 2');

    const deleteAgain = providersModule.deleteProvider(added.id);
    assert.strictEqual(deleteAgain, false, 'deleteProvider must return false if provider no longer exists');

    const diskAfterDelete = JSON.parse(fs.readFileSync(PROVIDERS_FILE, 'utf8'));
    assert.strictEqual(diskAfterDelete.length, 2, 'Disk persistence must reflect 2 providers after deletion');
    console.log('  Passed Test 6.\n');

    // -------------------------------------------------------------
    // Test 7: HTTP Probe Mock Server (OpenAI & Anthropic)
    // -------------------------------------------------------------
    console.log('Test 7: probeProvider() with Mock HTTP Server...');
    let requestLogs = [];
    const server = http.createServer((req, res) => {
      let reqBody = '';
      req.on('data', (chunk) => {
        reqBody += chunk;
      });
      req.on('end', () => {
        requestLogs.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: reqBody ? JSON.parse(reqBody) : null,
        });

        if (req.url === '/v1/chat/completions') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
        } else if (req.url === '/v1/messages') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ content: [{ text: 'pong' }] }));
        } else if (req.url === '/v1/failing') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Internal provider outage' } }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
        }
      });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const testBaseURL = `http://127.0.0.1:${port}/v1`;

    // 7A: OpenAI probe success
    requestLogs = [];
    const openaiTest = providersModule.addProvider({
      name: 'Mock OpenAI',
      type: 'openai',
      baseURL: testBaseURL,
      apiKey: 'test-openai-key',
      model: 'mock-gpt-model',
    });

    const probeResultOpenAI = await providersModule.probeProvider(openaiTest.id);
    assert.strictEqual(probeResultOpenAI.success, true, 'OpenAI probe must succeed');
    assert.strictEqual(typeof probeResultOpenAI.latencyMs, 'number');
    assert.ok(probeResultOpenAI.latencyMs >= 0);

    assert.strictEqual(requestLogs.length, 1);
    assert.strictEqual(requestLogs[0].url, '/v1/chat/completions');
    assert.strictEqual(requestLogs[0].headers.authorization, 'Bearer test-openai-key');
    assert.strictEqual(requestLogs[0].body.model, 'mock-gpt-model');
    assert.strictEqual(requestLogs[0].body.messages[0].content, 'hello');

    const verifiedOpenAI = providersModule.getProvider(openaiTest.id);
    assert.strictEqual(verifiedOpenAI.status, 'active');
    assert.strictEqual(verifiedOpenAI.lastError, null);
    assert.strictEqual(verifiedOpenAI.disabledUntil, 0);
    assert.ok(verifiedOpenAI.lastChecked > 0);
    console.log('  Passed Test 7A (OpenAI probe success).');

    // 7B: Anthropic probe success
    requestLogs = [];
    const anthropicTest = providersModule.addProvider({
      name: 'Mock Anthropic',
      type: 'anthropic',
      baseURL: testBaseURL,
      apiKey: 'test-anthropic-key',
      model: 'mock-claude-model',
    });

    const probeResultAnthropic = await providersModule.probeProvider(anthropicTest.id);
    assert.strictEqual(probeResultAnthropic.success, true, 'Anthropic probe must succeed');
    assert.strictEqual(requestLogs.length, 1);
    assert.strictEqual(requestLogs[0].url, '/v1/messages');
    assert.strictEqual(requestLogs[0].headers['x-api-key'], 'test-anthropic-key');
    assert.strictEqual(requestLogs[0].headers['anthropic-version'], '2023-06-01');
    assert.strictEqual(requestLogs[0].body.model, 'mock-claude-model');
    assert.strictEqual(requestLogs[0].body.messages[0].content, 'hello');

    const verifiedAnthropic = providersModule.getProvider(anthropicTest.id);
    assert.strictEqual(verifiedAnthropic.status, 'active');
    console.log('  Passed Test 7B (Anthropic probe success).');

    // 7C: Probe failure & 1-hour quarantine
    requestLogs = [];
    const failingTest = providersModule.addProvider({
      name: 'Mock Failing',
      type: 'openai',
      baseURL: `${testBaseURL}/failing`, // Will route to /v1/failing/chat/completions -> not found or 500
      apiKey: 'bad-key',
      model: 'fail-model',
    });
    // Update baseURL directly to trigger 500
    providersModule.updateProvider(failingTest.id, { baseURL: testBaseURL.replace('/v1', '') }); // Will request /chat/completions (404)

    const beforeProbeTime = Date.now();
    const probeFailResult = await providersModule.probeProvider(failingTest.id);
    assert.strictEqual(probeFailResult.success, false, 'Probe must return success: false on failure');
    assert.ok(probeFailResult.error.includes('HTTP 404'), 'Error message must include HTTP status');

    const verifiedFailing = providersModule.getProvider(failingTest.id);
    assert.strictEqual(verifiedFailing.status, 'quarantined');
    assert.ok(verifiedFailing.disabledUntil >= beforeProbeTime + 3500000, 'disabledUntil must be set ~1 hour ahead');
    assert.ok(verifiedFailing.lastError.includes('HTTP 404'));
    console.log('  Passed Test 7C (Failure and quarantine).');

    // Clean up mock providers
    providersModule.deleteProvider(openaiTest.id);
    providersModule.deleteProvider(anthropicTest.id);
    providersModule.deleteProvider(failingTest.id);

    await new Promise((resolve) => server.close(resolve));
    console.log('  Passed Test 7.\n');

    // -------------------------------------------------------------
    // Test 8: probeAllProviders()
    // -------------------------------------------------------------
    console.log('Test 8: probeAllProviders()...');
    const probeAllMockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
    });
    await new Promise((resolve) => probeAllMockServer.listen(0, '127.0.0.1', resolve));
    const probeAllPort = probeAllMockServer.address().port;

    const probeAllP1 = providersModule.addProvider({
      name: 'ProbeAll P1',
      type: 'openai',
      baseURL: `http://127.0.0.1:${probeAllPort}`,
      apiKey: 'k1',
      model: 'm1',
      enabled: true,
    });
    const probeAllP2 = providersModule.addProvider({
      name: 'ProbeAll P2 (disabled)',
      type: 'openai',
      baseURL: `http://127.0.0.1:${probeAllPort}`,
      apiKey: 'k2',
      model: 'm2',
      enabled: false,
    });

    const allResults = await providersModule.probeAllProviders();
    assert.strictEqual(Array.isArray(allResults), true);
    // Should probe only enabled providers
    const p1Result = allResults.find((r) => r.id === probeAllP1.id);
    const p2Result = allResults.find((r) => r.id === probeAllP2.id);
    assert.ok(p1Result, 'Enabled provider must be probed');
    assert.strictEqual(p1Result.success, true);
    assert.strictEqual(p2Result, undefined, 'Disabled provider must not be probed');

    providersModule.deleteProvider(probeAllP1.id);
    providersModule.deleteProvider(probeAllP2.id);
    await new Promise((resolve) => probeAllMockServer.close(resolve));
    console.log('  Passed Test 8.\n');

    // -------------------------------------------------------------
    // Test 9: Health Scheduler start/stop
    // -------------------------------------------------------------
    console.log('Test 9: startProviderHealthScheduler() and stopProviderHealthScheduler()...');
    assert.strictEqual(providersModule.isHealthSchedulerRunning(), false, 'Scheduler initially stopped');
    providersModule.startProviderHealthScheduler();
    assert.strictEqual(providersModule.isHealthSchedulerRunning(), true, 'Scheduler is running');
    const stopped = providersModule.stopProviderHealthScheduler();
    assert.strictEqual(stopped, true, 'Scheduler stop returns true');
    assert.strictEqual(providersModule.isHealthSchedulerRunning(), false, 'Scheduler is now stopped');
    console.log('  Passed Test 9.\n');

    console.log('=== All Task 3 and Task 4 Tests Passed Successfully! ===\n');
  } finally {
    // Restore backup if original existed
    if (hadOriginalFile && fs.existsSync(BACKUP_FILE)) {
      fs.copyFileSync(BACKUP_FILE, PROVIDERS_FILE);
      fs.unlinkSync(BACKUP_FILE);
    }
  }
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
