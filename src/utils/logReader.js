const fs = require('fs').promises;
const config = require('../../config');
const { safeExec } = require('./exec');

function clampPositiveInt(value, fallback, max) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function splitLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter(Boolean);
}

async function statFile(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

async function readDirectChunk(filePath, offset, maxBytes, fileSize) {
  const length = Math.min(maxBytes, Math.max(0, fileSize - offset));
  if (length <= 0) return '';

  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readLogChunk(filePath, offset = 0, maxBytes = config.LOG_TAIL_MAX_BYTES) {
  if (!filePath) return { stdout: '', entries: [], newOffset: offset, success: false };

  const stat = await statFile(filePath);
  if (!stat) return { stdout: '', entries: [], newOffset: offset, success: false };

  const effectiveOffset = stat.size < offset ? 0 : offset;
  if (stat.size <= effectiveOffset) {
    return { stdout: '', entries: [], newOffset: stat.size, success: true };
  }

  const limit = clampPositiveInt(maxBytes, config.LOG_TAIL_MAX_BYTES, 1024 * 1024);

  try {
    const stdout = await readDirectChunk(filePath, effectiveOffset, limit, stat.size);
    return { stdout, entries: splitLines(stdout), newOffset: stat.size, success: true };
  } catch {
    // Fall back to sudo for root-owned logs. Arguments after the script become
    // positional parameters, so log paths are never interpolated into shell code.
    const result = await safeExec(
      'bash',
      [
        '-c',
        'sudo tail -c +"$1" "$2" | head -c "$3"',
        'read-log-chunk',
        String(effectiveOffset + 1),
        filePath,
        String(limit),
      ],
      { timeout: 5000, maxBuffer: limit + 4096 }
    );

    if (!result.success) {
      return { stdout: '', entries: [], newOffset: effectiveOffset, success: false, stderr: result.stderr };
    }

    return { stdout: result.stdout, entries: splitLines(result.stdout), newOffset: stat.size, success: true };
  }
}

async function tailLog(filePath, lines = 20, timeout = 5000) {
  if (!filePath) return { stdout: '', success: false };
  const safeLines = clampPositiveInt(lines, 20, 500);

  let result = await safeExec('tail', [`-${safeLines}`, filePath], { timeout });
  if (result.success) return result;

  result = await safeExec('sudo', ['tail', `-${safeLines}`, filePath], { timeout });
  return result;
}

async function grepCount(filePath, fixedString, timeout = 5000) {
  if (!filePath || !fixedString) return { count: 0, success: false };
  const result = await safeExec('sudo', ['grep', '-F', '-c', '--', fixedString, filePath], { timeout });
  return { count: parseInt(result.stdout.trim(), 10) || 0, success: result.success, stderr: result.stderr };
}

module.exports = { readLogChunk, tailLog, grepCount, splitLines };
