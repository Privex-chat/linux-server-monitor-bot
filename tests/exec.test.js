const { safeExec, readProcFile } = require('../utils/exec');

describe('safeExec', () => {
  test('runs command with array args (execFile path)', async () => {
    const result = await safeExec(process.execPath, ['-e', "console.log('hello')"]);
    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.stderr).toBe('');
  });

  test('returns success:false on non-existent command', async () => {
    const result = await safeExec('nonexistent_cmd_12345', ['arg']);
    expect(result.success).toBe(false);
    expect(result.stderr).toBeTruthy();
  });

  test('respects timeout option', async () => {
    // Sleep should time out
    const result = await safeExec(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 100 });
    expect(result.success).toBe(false);
  }, 10000);

  test('handles empty args (shell exec path)', async () => {
    const result = await safeExec(`"${process.execPath}" -e "console.log('hello world')"`, []);
    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe('hello world');
  });

  test('returns stdout and stderr separately', async () => {
    const result = await safeExec(process.execPath, ['-e', "console.log('out'); console.error('err')"]);
    expect(result.success).toBe(true);
    expect(result.stdout.trim()).toBe('out');
    expect(result.stderr.trim()).toBe('err');
  });
});

describe('readProcFile', () => {
  test('reads an existing file', async () => {
    const result = await readProcFile(__filename);
    expect(result.success).toBe(true);
    expect(result.content).toContain('readProcFile');
  });

  test('returns success:false for non-existent file', async () => {
    const result = await readProcFile('/nonexistent/file/path');
    expect(result.success).toBe(false);
    expect(result.content).toBe('');
  });
});
