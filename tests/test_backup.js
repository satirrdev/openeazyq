// Tests for Scheduled Automatic Backup and /backup admin command.

const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const {
  calcCrc32,
  formatDosDateTime,
  createZipBuffer,
  createBackupArchive,
  performBackup,
  getMsUntilNext0500UTC,
  startBackupScheduler,
  stopBackupScheduler,
} = require('../backup');
const botModule = require('../bot');

async function runTests() {
  console.log('=== Running Backup Module Tests ===\n');

  // Test 1: CRC32 Calculation
  {
    console.log('Test 1: CRC32 calculations...');
    const emptyBuf = Buffer.alloc(0);
    assert.equal(calcCrc32(emptyBuf), 0, 'CRC-32 of empty buffer must be 0');

    const helloBuf = Buffer.from('hello', 'utf8');
    const expectedCrcHello = 907060870; // 0x3610a686
    assert.equal(calcCrc32(helloBuf), expectedCrcHello, 'CRC-32 of "hello" must match known value');

    const testStr = 'GampangBot automated backup test content 12345!@#$%';
    const testBuf = Buffer.from(testStr, 'utf8');
    const nodeCrc = typeof zlib.crc32 === 'function' ? (zlib.crc32(testBuf) >>> 0) : null;
    if (nodeCrc !== null) {
      assert.equal(calcCrc32(testBuf), nodeCrc, 'Custom calcCrc32 must match node zlib.crc32');
    }
    console.log('  Passed Test 1.');
  }

  // Test 2: DOS Date and Time conversion
  {
    console.log('Test 2: DOS Date and Time formatting...');
    const testDate = new Date('2026-05-15T10:30:20Z');
    const dos = formatDosDateTime(testDate);
    assert.ok(typeof dos.time === 'number' && dos.time >= 0, 'dos.time must be a positive number');
    assert.ok(typeof dos.date === 'number' && dos.date >= 0, 'dos.date must be a positive number');

    // Test default date fallback
    const fallbackDos = formatDosDateTime(null);
    assert.ok(typeof fallbackDos.time === 'number');
    assert.ok(typeof fallbackDos.date === 'number');
    console.log('  Passed Test 2.');
  }

  // Test 3: Zero-Dependency PKZIP Buffer Generation
  {
    console.log('Test 3: Zero-Dependency PKZIP Buffer Generator...');
    // Empty files array
    const emptyZip = createZipBuffer([]);
    assert.ok(Buffer.isBuffer(emptyZip), 'createZipBuffer([]) must return a Buffer');
    assert.equal(emptyZip.length, 22, 'Empty zip file must consist solely of 22-byte EOCD');
    assert.equal(emptyZip.readUInt32LE(0), 0x06054b50, 'EOCD signature must match 0x06054b50');

    // Array with text and binary files
    const sampleFiles = [
      { name: 'test.txt', data: 'Hello from GampangBot!' },
      { name: 'data/empty.json', data: '' },
      { name: 'sub/nested/file.bin', data: Buffer.from([1, 2, 3, 4, 5]) },
    ];
    const zipBuf = createZipBuffer(sampleFiles);
    assert.ok(Buffer.isBuffer(zipBuf));
    assert.ok(zipBuf.length > 50, 'Generated zip buffer must contain headers and content');
    assert.equal(zipBuf.readUInt32LE(0), 0x04034b50, 'Local header signature must match 0x04034b50');

    // Verify invalid input handling
    assert.throws(() => createZipBuffer('not-an-array'), TypeError);
    console.log('  Passed Test 3.');
  }

  // Test 4: Backup Archive and Metadata Assembly
  {
    console.log('Test 4: Backup Archive and Metadata Assembler...');
    const tempDir = path.join(__dirname, 'temp_backup_test');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const mockUsersPath = path.join(tempDir, 'users.json');
    const mockUsers = {
      user_1: { quizCount: 3, premiumUntil: Date.now() + 86400000 },
      user_2: { quizCount: 1, premiumUntil: 0 },
    };
    fs.writeFileSync(mockUsersPath, JSON.stringify(mockUsers, null, 2), 'utf8');

    try {
      const archive = createBackupArchive({
        dataDir: tempDir,
        usersPath: mockUsersPath,
      });

      assert.ok(Buffer.isBuffer(archive.buffer), 'Archive buffer must be a Buffer');
      assert.ok(archive.filename.startsWith('gampangbot-backup-'), 'Filename must start with prefix');
      assert.ok(archive.filename.endsWith('.zip'), 'Filename must end with .zip');
      assert.equal(archive.metadata.appName, 'GampangBot');
      assert.equal(archive.metadata.userCount, 2, 'Metadata must accurately reflect 2 users');
      assert.equal(archive.metadata.premiumCount, 1, 'Metadata must accurately reflect 1 premium user');
      assert.ok(archive.metadata.createdAtWIB, 'Metadata must include Jakarta timestamp');
    } finally {
      if (fs.existsSync(mockUsersPath)) fs.unlinkSync(mockUsersPath);
      if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    }
    console.log('  Passed Test 4.');
  }

  // Test 5: Backup Delivery Service
  {
    console.log('Test 5: Backup Delivery Service...');
    // Case 5a: No recipient configured
    const prevAdmin = process.env.ADMIN_ID;
    delete process.env.ADMIN_ID;
    const noRecipientResult = await performBackup(null, null);
    assert.equal(noRecipientResult.success, false);
    assert.equal(noRecipientResult.reason, 'NO_RECIPIENT');
    process.env.ADMIN_ID = prevAdmin;

    // Case 5b: Successful delivery with markdown caption
    let sendDocumentCalls = [];
    const mockBot = {
      sendDocument: async (chatId, doc, options, fileOptions) => {
        sendDocumentCalls.push({ chatId, doc, options, fileOptions });
        return { message_id: 1234 };
      },
    };

    const deliveryResult = await performBackup(mockBot, '123456789');
    assert.equal(deliveryResult.success, true);
    assert.equal(sendDocumentCalls.length, 1);
    assert.equal(sendDocumentCalls[0].chatId, '123456789');
    assert.ok(Buffer.isBuffer(sendDocumentCalls[0].doc));
    assert.equal(sendDocumentCalls[0].fileOptions.contentType, 'application/zip');
    assert.ok(sendDocumentCalls[0].options.caption.includes('Backup Data GampangBot'));

    // Case 5c: Delivery markdown failure retry with plain text
    sendDocumentCalls = [];
    let attempts = 0;
    const mockBotMarkdownFail = {
      sendDocument: async (chatId, doc, options, fileOptions) => {
        attempts++;
        if (attempts === 1) {
          throw new Error('400 Bad Request: can\'t parse entities in message caption');
        }
        sendDocumentCalls.push({ chatId, doc, options, fileOptions });
        return { message_id: 5678 };
      },
    };

    const retryResult = await performBackup(mockBotMarkdownFail, '987654321');
    assert.equal(retryResult.success, true);
    assert.equal(attempts, 2, 'Must have attempted twice (markdown then plain text)');
    assert.equal(sendDocumentCalls.length, 1);
    assert.ok(!sendDocumentCalls[0].options.parse_mode, 'Plain text fallback must not specify parse_mode');
    console.log('  Passed Test 5.');
  }

  // Test 6: 05:00 UTC Delay Calculation
  {
    console.log('Test 6: 05:00 UTC Delay Calculation...');
    // Before 05:00 UTC (e.g. 04:00 UTC): remaining = 1 hour (3600000 ms)
    const t0400 = new Date('2026-05-10T04:00:00.000Z');
    assert.equal(getMsUntilNext0500UTC(t0400), 3600000);

    // Exactly 05:00 UTC: remaining = 24 hours (86400000 ms)
    const t0500 = new Date('2026-05-10T05:00:00.000Z');
    assert.equal(getMsUntilNext0500UTC(t0500), 86400000);

    // After 05:00 UTC (e.g. 07:00 UTC): remaining = 22 hours (79200000 ms)
    const t0700 = new Date('2026-05-10T07:00:00.000Z');
    assert.equal(getMsUntilNext0500UTC(t0700), 22 * 3600000);

    // End of year rollover (Dec 31 at 06:00 UTC): remaining = 23 hours
    const tDec31 = new Date('2026-12-31T06:00:00.000Z');
    assert.equal(getMsUntilNext0500UTC(tDec31), 23 * 3600000);
    console.log('  Passed Test 6.');
  }

  // Test 7: Backup Scheduler Lifecycle
  {
    console.log('Test 7: Backup Scheduler Start and Stop...');
    const dummyBot = {};
    const timer = startBackupScheduler(dummyBot);
    assert.ok(timer, 'startBackupScheduler must return a timer object');
    stopBackupScheduler();
    console.log('  Passed Test 7.');
  }

  // Test 8: Admin /backup Command Routing and Access Control
  {
    console.log('Test 8: Admin /backup command handler...');
    const originalAdminId = process.env.ADMIN_ID;
    process.env.ADMIN_ID = '999999';

    const sentMessages = [];
    const registeredHandlers = {};

    const mockBot = {
      onText: (regex, fn) => {
        registeredHandlers[regex.toString()] = fn;
      },
      on: () => {},
      sendMessage: async (chatId, text, options) => {
        sentMessages.push({ chatId, text, options });
        return { message_id: 111 };
      },
      sendDocument: async (chatId, doc, options, fileOptions) => {
        sentMessages.push({ chatId, doc, options, fileOptions });
        return { message_id: 222 };
      },
    };

    botModule.register(mockBot);

    // Find the /backup handler
    const backupKey = Object.keys(registeredHandlers).find((k) => k.includes('backup'));
    assert.ok(backupKey, 'A handler for /backup must be registered with bot.onText');
    const backupHandler = registeredHandlers[backupKey];

    // Case 8a: Unauthorized non-admin user
    sentMessages.length = 0;
    await backupHandler({
      chat: { id: 111222 },
      from: { id: 111222 },
    });
    assert.equal(sentMessages.length, 1);
    assert.ok(
      sentMessages[0].text.includes('Akses ditolak'),
      'Non-admin user must receive access denied notice'
    );

    // Case 8b: Sender without `from` object (e.g. anonymous sender)
    sentMessages.length = 0;
    await backupHandler({
      chat: { id: 111222 },
    });
    assert.equal(sentMessages.length, 1);
    assert.ok(
      sentMessages[0].text.includes('Akses ditolak'),
      'Sender without from object must receive access denied notice'
    );

    // Case 8c: Authorized admin user
    sentMessages.length = 0;
    await backupHandler({
      chat: { id: 999999 },
      from: { id: 999999 },
    });
    // Expected: 1 waiting notice + 1 sendDocument delivery
    assert.equal(sentMessages.length, 2);
    assert.ok(sentMessages[0].text.includes('lagi nyiapin file backup data'));
    assert.ok(Buffer.isBuffer(sentMessages[1].doc));
    assert.equal(sentMessages[1].fileOptions.contentType, 'application/zip');

    process.env.ADMIN_ID = originalAdminId;
    console.log('  Passed Test 8.');
  }

  console.log('\nAll Backup Tests Passed Successfully! \u2705');
}

runTests().catch((err) => {
  console.error('\nTest Suite Failed:', err);
  process.exit(1);
});
