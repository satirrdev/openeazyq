const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let crcTable = null;

function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
}

function calcCrc32(buf) {
  if (typeof zlib.crc32 === 'function') {
    return zlib.crc32(buf) >>> 0;
  }
  if (!crcTable) {
    crcTable = makeCrcTable();
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function formatDosDateTime(date = new Date()) {
  const d = (date instanceof Date && !isNaN(date.getTime())) ? date : new Date();
  const time = (
    (d.getHours() << 11) |
    (d.getMinutes() << 5) |
    Math.floor(d.getSeconds() / 2)
  ) & 0xffff;

  const year = Math.max(1980, d.getFullYear());
  const dosDate = (
    ((year - 1980) << 9) |
    ((d.getMonth() + 1) << 5) |
    d.getDate()
  ) & 0xffff;

  return { time, date: dosDate };
}

function createZipBuffer(files) {
  if (!Array.isArray(files)) {
    throw new TypeError('createZipBuffer expects an array of files');
  }

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const f of files) {
    if (!f || typeof f !== 'object') continue;

    const rawName = String(f.name || 'unnamed')
      .replace(/\\/g, '/')
      .replace(/^\/+/, '');
    const nameBuf = Buffer.from(rawName, 'utf8');
    const rawData = Buffer.isBuffer(f.data)
      ? f.data
      : Buffer.from(String(f.data ?? ''), 'utf8');

    const crc = calcCrc32(rawData);
    const deflated = zlib.deflateRawSync(rawData);
    const dos = formatDosDateTime(f.date);

    // Local file header (30 bytes)
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // Local header signature
    lh.writeUInt16LE(20, 4); // Version needed to extract (2.0)
    lh.writeUInt16LE(0x0800, 6); // General purpose bit flag (UTF-8 filename)
    lh.writeUInt16LE(8, 8); // Compression method (Deflate)
    lh.writeUInt16LE(dos.time, 10); // Last mod file time
    lh.writeUInt16LE(dos.date, 12); // Last mod file date
    lh.writeUInt32LE(crc, 14); // CRC-32
    lh.writeUInt32LE(deflated.length, 18); // Compressed size
    lh.writeUInt32LE(rawData.length, 22); // Uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26); // File name length
    lh.writeUInt16LE(0, 28); // Extra field length

    localParts.push(lh, nameBuf, deflated);

    // Central directory header (46 bytes)
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // Central directory signature
    cd.writeUInt16LE(20, 4); // Version made by (DOS / 2.0)
    cd.writeUInt16LE(20, 6); // Version needed to extract (2.0)
    cd.writeUInt16LE(0x0800, 8); // General purpose bit flag (UTF-8)
    cd.writeUInt16LE(8, 10); // Compression method (Deflate)
    cd.writeUInt16LE(dos.time, 12); // Last mod file time
    cd.writeUInt16LE(dos.date, 14); // Last mod file date
    cd.writeUInt32LE(crc, 16); // CRC-32
    cd.writeUInt32LE(deflated.length, 20); // Compressed size
    cd.writeUInt32LE(rawData.length, 24); // Uncompressed size
    cd.writeUInt16LE(nameBuf.length, 28); // File name length
    cd.writeUInt16LE(0, 30); // Extra field length
    cd.writeUInt16LE(0, 32); // File comment length
    cd.writeUInt16LE(0, 34); // Disk number start
    cd.writeUInt16LE(0, 36); // Internal file attributes
    cd.writeUInt32LE(0, 38); // External file attributes
    cd.writeUInt32LE(offset, 42); // Relative offset of local header

    centralParts.push(cd, nameBuf);

    offset += 30 + nameBuf.length + deflated.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const p of centralParts) {
    cdSize += p.length;
  }

  const validCount = centralParts.length / 2;

  // End of Central Directory Record (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4); // Number of this disk
  eocd.writeUInt16LE(0, 6); // Disk where central directory starts
  eocd.writeUInt16LE(validCount, 8); // Entries on this disk
  eocd.writeUInt16LE(validCount, 10); // Total entries
  eocd.writeUInt32LE(cdSize, 12); // Central directory size
  eocd.writeUInt32LE(cdOffset, 16); // Central directory offset
  eocd.writeUInt16LE(0, 20); // ZIP file comment length

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

function createBackupArchive(options = {}) {
  const dataDir = options.dataDir || path.join(__dirname, 'data');
  const usersPath = options.usersPath || path.join(dataDir, 'users.json');

  let usersContent = '{}';
  if (fs.existsSync(usersPath)) {
    try {
      usersContent = fs.readFileSync(usersPath, 'utf8');
    } catch (err) {
      console.error('[Backup] Failed to read users.json:', err.message);
    }
  }

  let usersObj = {};
  try {
    usersObj = JSON.parse(usersContent);
  } catch (err) {
    console.error('[Backup] Failed to parse users.json:', err.message);
  }

  const userIds = Object.keys(usersObj);
  const userCount = userIds.length;
  const now = Date.now();
  let premiumCount = 0;
  for (const id of userIds) {
    const u = usersObj[id];
    if (u && typeof u.premiumUntil === 'number' && u.premiumUntil > now) {
      premiumCount++;
    }
  }

  let appVersion = '0.1.0';
  try {
    const pkgPath = path.join(__dirname, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg && pkg.version) {
        appVersion = pkg.version;
      }
    }
  } catch (_) {}

  const createdAt = new Date();
  const createdAtISO = createdAt.toISOString();
  const createdAtWIB = createdAt.toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
  });

  const metadata = {
    appName: 'GampangBot',
    version: appVersion,
    createdAt: createdAtISO,
    createdAtWIB,
    userCount,
    premiumCount,
    nodeVersion: process.version,
    platform: process.platform,
  };

  const pad = (n) => String(n).padStart(2, '0');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(createdAt);
  const partMap = {};
  for (const p of parts) {
    partMap[p.type] = p.value;
  }
  const ts = `${partMap.year}${partMap.month}${partMap.day}-${partMap.hour}${partMap.minute}${partMap.second}`;
  const filename = options.filename || `gampangbot-backup-${ts}.zip`;

  const files = [
    { name: 'users.json', data: usersContent, date: createdAt },
    {
      name: 'metadata.json',
      data: JSON.stringify(metadata, null, 2),
      date: createdAt,
    },
  ];

  const buffer = createZipBuffer(files);

  return {
    buffer,
    filename,
    metadata,
  };
}

async function performBackup(bot, targetChatId = null, options = {}) {
  const destChatId = targetChatId || process.env.ADMIN_ID;
  if (!destChatId) {
    console.warn('[Backup] No target chat ID or ADMIN_ID configured, skipping backup delivery.');
    return { success: false, reason: 'NO_RECIPIENT' };
  }

  console.log(`[Backup] Generating backup archive for destination ${destChatId}...`);
  const archive = createBackupArchive(options);

  const caption =
    `📦 *Backup Data GampangBot*\n\n` +
    `📅 Waktu: ${archive.metadata.createdAtWIB} WIB\n` +
    `👥 Total User: ${archive.metadata.userCount}\n` +
    `⭐ User Premium: ${archive.metadata.premiumCount}\n` +
    `📁 Ukuran: ${(archive.buffer.length / 1024).toFixed(2)} KB\n\n` +
    `File: \`${archive.filename}\``;

  try {
    await bot.sendDocument(
      destChatId,
      archive.buffer,
      {
        caption,
        parse_mode: 'Markdown',
      },
      {
        filename: archive.filename,
        contentType: 'application/zip',
      }
    );
    console.log(`[Backup] Backup delivered successfully to ${destChatId} (${archive.filename}).`);
    return { success: true, archive };
  } catch (err) {
    console.warn(`[Backup] Markdown delivery failed (${err.message}), retrying with plain text caption...`);
    try {
      const plainCaption = caption.replace(/[*_`]/g, '');
      await bot.sendDocument(
        destChatId,
        archive.buffer,
        {
          caption: plainCaption,
        },
        {
          filename: archive.filename,
          contentType: 'application/zip',
        }
      );
      console.log(`[Backup] Backup delivered successfully with plain caption to ${destChatId}.`);
      return { success: true, archive };
    } catch (fallbackErr) {
      console.error(`[Backup] Critical failure delivering backup archive: ${fallbackErr.message}`);
      throw fallbackErr;
    }
  }
}

function getMsUntilNext0500UTC(now = new Date()) {
  const cur = new Date(now);
  const target = new Date(Date.UTC(
    cur.getUTCFullYear(),
    cur.getUTCMonth(),
    cur.getUTCDate(),
    5, 0, 0, 0
  ));

  if (target.getTime() <= cur.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }

  return target.getTime() - cur.getTime();
}

let schedulerTimer = null;

function stopBackupScheduler() {
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
}

function startBackupScheduler(bot) {
  stopBackupScheduler();

  const delayMs = getMsUntilNext0500UTC();
  const hours = (delayMs / 3600000).toFixed(2);
  console.log(`[Backup] Automatic backup scheduler activated. Next run in ${hours} hours.`);

  schedulerTimer = setTimeout(async () => {
    try {
      console.log('[Backup] Executing scheduled daily backup at 05:00 UTC...');
      await performBackup(bot);
    } catch (err) {
      console.error('[Backup] Scheduled backup run failed:', err.message);
    } finally {
      startBackupScheduler(bot);
    }
  }, delayMs);

  if (schedulerTimer && typeof schedulerTimer.unref === 'function') {
    schedulerTimer.unref();
  }

  return schedulerTimer;
}

module.exports = {
  calcCrc32,
  formatDosDateTime,
  createZipBuffer,
  createBackupArchive,
  performBackup,
  getMsUntilNext0500UTC,
  startBackupScheduler,
  stopBackupScheduler,
};
