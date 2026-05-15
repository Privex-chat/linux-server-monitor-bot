const { execFile, exec } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

/**
 * Safely execute a command with timeout.
 * Returns { stdout, stderr, success }.
 */
async function safeExec(command, args = [], options = {}) {
  const timeout = options.timeout || 10000;
  try {
    if (Array.isArray(args) && args.length > 0) {
      const result = await execFileAsync(command, args, {
        timeout,
        maxBuffer: 1024 * 1024 * 10,
        ...options,
      });
      return { stdout: result.stdout, stderr: result.stderr, success: true };
    } else {
      const cmd = args.length ? `${command} ${args}` : command;
      const result = await execAsync(cmd, {
        timeout,
        maxBuffer: 1024 * 1024 * 10,
        ...options,
      });
      return { stdout: result.stdout, stderr: result.stderr, success: true };
    }
  } catch (error) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || error.message,
      success: false,
    };
  }
}

/**
 * Read a pseudo-file (e.g. /proc/*).
 */
async function readProcFile(filePath) {
  const fs = require('fs').promises;
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return { content, success: true };
  } catch (error) {
    return { content: '', success: false, error: error.message };
  }
}

module.exports = { safeExec, readProcFile };
