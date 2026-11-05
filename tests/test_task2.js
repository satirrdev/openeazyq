const assert = require('assert').strict;
const botModule = require('../bot');
const store = require('../store');

async function runTests() {
  console.log('=== Running Task 2 Verification Tests ===\n');

  // Test 1: Exports check
  console.log('Test 1: Exports presence...');
  assert.strictEqual(typeof botModule.sendDirectMessage, 'function', 'sendDirectMessage must be exported as a function');
  assert.strictEqual(typeof botModule.broadcastMessage, 'function', 'broadcastMessage must be exported as a function');
  assert.strictEqual(typeof botModule.isBroadcasting, 'function', 'isBroadcasting must be exported as a function');
  assert.strictEqual(botModule.isBroadcasting(), false, 'isBroadcasting() should initially return false');
  console.log('  Passed Test 1.\n');

  // Test 2: Uninitialized botInstance error handling
  console.log('Test 2: Uninitialized botInstance guards...');
  botModule.setBotInstance(null);

  await assert.rejects(
    async () => {
      await botModule.sendDirectMessage('12345', 'Halo');
    },
    /Bot instance belum diinisialisasi/,
    'sendDirectMessage must throw descriptive error if botInstance is null'
  );

  await assert.rejects(
    async () => {
      await botModule.broadcastMessage('Halo broadcast');
    },
    /Bot instance belum diinisialisasi/,
    'broadcastMessage must throw descriptive error if botInstance is null'
  );
  console.log('  Passed Test 2.\n');

  // Test 3: Saving botInstance via register(bot)
  console.log('Test 3: register(bot) saves botInstance...');
  const sentMessages = [];
  const mockBot = {
    setMyCommands: async () => {},
    onText: () => {},
    on: () => {},
    sendMessage: async (chatId, text, opts) => {
      sentMessages.push({ chatId, text, opts });
      return { message_id: sentMessages.length * 100 };
    },
  };

  botModule.register(mockBot);
  assert.strictEqual(botModule.getBotInstance(), mockBot, 'botInstance should be set to mockBot after register(bot)');
  console.log('  Passed Test 3.\n');

  // Test 4: sendDirectMessage happy path & messageId return
  console.log('Test 4: sendDirectMessage happy path...');
  sentMessages.length = 0;
  const directRes = await botModule.sendDirectMessage(123456, 'Pesan langsung untuk kamu');
  assert.strictEqual(directRes.success, true, 'Direct message should return success: true');
  assert.strictEqual(directRes.messageId, 100, 'Direct message should return correct messageId');
  assert.strictEqual(sentMessages.length, 1, 'Exactly 1 message should be sent');
  assert.strictEqual(sentMessages[0].chatId, 123456, 'Target chatId should match');
  console.log('  Passed Test 4.\n');

  // Test 5: sendDirectMessage delivery failure error throwing
  console.log('Test 5: sendDirectMessage delivery failure...');
  const failingBot = {
    setMyCommands: async () => {},
    onText: () => {},
    on: () => {},
    sendMessage: async () => {
      throw new Error('403 Forbidden: bot was blocked by the user');
    },
  };
  botModule.setBotInstance(failingBot);

  await assert.rejects(
    async () => {
      await botModule.sendDirectMessage(99999, 'Tes gagal');
    },
    (err) => {
      assert.match(err.message, /Gagal mengirim pesan ke 99999/);
      assert.match(err.message, /bot was blocked by the user/);
      return true;
    },
    'Should throw descriptive delivery error'
  );
  console.log('  Passed Test 5.\n');

  // Restore mockBot for broadcast tests
  botModule.setBotInstance(mockBot);

  // Test 6: broadcastMessage input validation
  console.log('Test 6: broadcastMessage input validation...');
  await assert.rejects(
    async () => {
      await botModule.broadcastMessage('');
    },
    /Pesan broadcast tidak boleh kosong/,
    'Empty text must be rejected'
  );
  await assert.rejects(
    async () => {
      await botModule.broadcastMessage('   ');
    },
    /Pesan broadcast tidak boleh kosong/,
    'Whitespace text must be rejected'
  );
  console.log('  Passed Test 6.\n');

  // Test 7: broadcastMessage happy path, filtering & summary
  console.log('Test 7: broadcastMessage user filtering and sequential delivery...');
  // Mock store.getAllUsers
  const originalGetAllUsers = store.getAllUsers;
  store.getAllUsers = () => [
    { userId: '11111' },
    { userId: 'invalid_abc' }, // Should be filtered out
    { userId: '22222' },
    { userId: null }, // Should be filtered out
    { userId: '33333' },
  ];

  sentMessages.length = 0;
  const startTs = Date.now();
  const broadcastRes = await botModule.broadcastMessage('Pemberitahuan penting!', { delayMs: 20 });
  const elapsed = Date.now() - startTs;

  assert.strictEqual(broadcastRes.total, 3, 'Total valid recipients should be 3');
  assert.strictEqual(broadcastRes.sent, 3, 'Sent count should be 3');
  assert.strictEqual(broadcastRes.failed, 0, 'Failed count should be 0');
  assert.deepStrictEqual(broadcastRes.failures, [], 'Failures list should be empty');
  assert.strictEqual(sentMessages.length, 3, 'Should have sent exactly 3 messages');
  assert.strictEqual(sentMessages[0].chatId, '11111');
  assert.strictEqual(sentMessages[1].chatId, '22222');
  assert.strictEqual(sentMessages[2].chatId, '33333');
  assert.strictEqual(botModule.isBroadcasting(), false, 'isBroadcasting() should be false after completion');
  // Two 20ms delays between 3 users => elapsed at least ~35ms
  assert.ok(elapsed >= 35, `Elapsed time should respect delay (was ${elapsed}ms)`);
  console.log('  Passed Test 7.\n');

  // Test 8: broadcastMessage error resilience (partial failures)
  console.log('Test 8: broadcastMessage resilience against individual failures...');
  store.getAllUsers = () => [
    { userId: '1001' },
    { userId: '1002' },
    { userId: '1003' },
  ];

  const partialBot = {
    setMyCommands: async () => {},
    onText: () => {},
    on: () => {},
    sendMessage: async (chatId) => {
      if (chatId === '1002') {
        throw new Error('403 Forbidden: bot was blocked by the user');
      }
      return { message_id: 1 };
    },
  };
  botModule.setBotInstance(partialBot);

  const partialRes = await botModule.broadcastMessage('Info untuk semua', { delayMs: 10 });
  assert.strictEqual(partialRes.total, 3, 'Total should be 3');
  assert.strictEqual(partialRes.sent, 2, 'Sent should be 2');
  assert.strictEqual(partialRes.failed, 1, 'Failed should be 1');
  assert.strictEqual(partialRes.failures.length, 1, 'Failures should contain 1 item');
  assert.strictEqual(partialRes.failures[0].userId, '1002');
  assert.match(partialRes.failures[0].error, /403 Forbidden/);
  console.log('  Passed Test 8.\n');

  // Test 9: Concurrent broadcast prevention
  console.log('Test 9: Concurrent broadcast prevention...');
  let releaseBroadcast;
  const blockingBot = {
    setMyCommands: async () => {},
    onText: () => {},
    on: () => {},
    sendMessage: async () => {
      await new Promise((resolve) => {
        releaseBroadcast = resolve;
      });
      return { message_id: 1 };
    },
  };
  botModule.setBotInstance(blockingBot);
  store.getAllUsers = () => [{ userId: '5001' }];

  const bPromise = botModule.broadcastMessage('Broadcast 1');
  assert.strictEqual(botModule.isBroadcasting(), true, 'isBroadcasting() should be true during broadcast');

  await assert.rejects(
    async () => {
      await botModule.broadcastMessage('Broadcast 2');
    },
    /Broadcast sedang berjalan/,
    'Concurrent broadcast must be rejected'
  );

  // Release first broadcast
  releaseBroadcast();
  await bPromise;
  assert.strictEqual(botModule.isBroadcasting(), false, 'isBroadcasting() should be reset to false after completion');
  console.log('  Passed Test 9.\n');

  // Restore original getAllUsers
  store.getAllUsers = originalGetAllUsers;

  console.log('=== All Task 2 Verification Tests Passed! ===\n');
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
