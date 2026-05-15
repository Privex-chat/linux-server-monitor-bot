const fs = require('fs');

// Save original implementations
const originalReadFileSync = fs.readFileSync;
const originalAccessSync = fs.accessSync;

describe('distro detection', () => {
  let distro;

  beforeEach(() => {
    // Clear module cache so each test gets fresh detection
    jest.resetModules();

    // Mock config and logger
    jest.mock('../../config', () => ({
      TIMEZONE: 'UTC',
      LOG_LEVEL: 'silent',
    }));
    jest.mock('../utils/logger', () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    }));
  });

  afterEach(() => {
    fs.readFileSync = originalReadFileSync;
    fs.accessSync = originalAccessSync;
  });

  test('detects Debian family from os-release', () => {
    fs.readFileSync = jest.fn().mockReturnValue(`ID=ubuntu\nID_LIKE=debian\nPRETTY_NAME="Ubuntu 22.04 LTS"\n`);
    distro = require('../utils/distro');
    expect(distro.detectFamily()).toBe('debian');
    expect(distro.getDistroInfo().name).toBe('Ubuntu 22.04 LTS');
  });

  test('detects RHEL family from os-release', () => {
    fs.readFileSync = jest
      .fn()
      .mockReturnValue(`ID=rocky\nID_LIKE="rhel centos fedora"\nPRETTY_NAME="Rocky Linux 9"\n`);
    distro = require('../utils/distro');
    expect(distro.detectFamily()).toBe('rhel');
  });

  test('detects Arch family from os-release', () => {
    fs.readFileSync = jest.fn().mockReturnValue(`ID=manjaro\nID_LIKE=arch\nPRETTY_NAME="Manjaro Linux"\n`);
    distro = require('../utils/distro');
    expect(distro.detectFamily()).toBe('arch');
  });

  test('detects Alpine from os-release', () => {
    fs.readFileSync = jest.fn().mockReturnValue(`ID=alpine\nPRETTY_NAME="Alpine Linux v3.18"\n`);
    distro = require('../utils/distro');
    expect(distro.detectFamily()).toBe('alpine');
  });

  test('detects SUSE family from os-release', () => {
    fs.readFileSync = jest
      .fn()
      .mockReturnValue(`ID=opensuse-leap\nID_LIKE="suse opensuse"\nPRETTY_NAME="openSUSE Leap 15.5"\n`);
    distro = require('../utils/distro');
    expect(distro.detectFamily()).toBe('suse');
  });

  test('returns unknown when os-release missing', () => {
    fs.readFileSync = jest.fn().mockImplementation(() => {
      throw new Error('ENOENT');
    });
    distro = require('../utils/distro');
    expect(distro.detectFamily()).toBe('unknown');
  });

  test('resolveLogPath returns env override when set', () => {
    fs.readFileSync = jest.fn().mockReturnValue(`ID=ubuntu\nID_LIKE=debian\n`);
    distro = require('../utils/distro');
    const result = distro.resolveLogPath('auth', '/custom/auth.log');
    expect(result).toBe('/custom/auth.log');
  });

  test('resolveLogPath finds existing file for distro', () => {
    fs.readFileSync = jest.fn().mockReturnValue(`ID=ubuntu\nID_LIKE=debian\n`);
    fs.accessSync = jest.fn().mockImplementation((p) => {
      if (p === '/var/log/auth.log') return undefined; // exists
      throw new Error('ENOENT');
    });
    distro = require('../utils/distro');
    const result = distro.resolveLogPath('auth', undefined);
    expect(result).toBe('/var/log/auth.log');
  });

  test('resolveLogPath returns null when no file found', () => {
    fs.readFileSync = jest.fn().mockReturnValue(`ID=ubuntu\nID_LIKE=debian\n`);
    fs.accessSync = jest.fn().mockImplementation(() => {
      throw new Error('ENOENT');
    });
    distro = require('../utils/distro');
    const result = distro.resolveLogPath('auth', undefined);
    expect(result).toBeNull();
  });

  test('resolveLogPath tries RHEL paths for RHEL family', () => {
    fs.readFileSync = jest.fn().mockReturnValue(`ID=centos\nID_LIKE="rhel fedora"\n`);
    fs.accessSync = jest.fn().mockImplementation((p) => {
      if (p === '/var/log/secure') return undefined;
      throw new Error('ENOENT');
    });
    distro = require('../utils/distro');
    const result = distro.resolveLogPath('auth', undefined);
    expect(result).toBe('/var/log/secure');
  });

  test('resolveLogPath returns RHEL syslog path (messages)', () => {
    fs.readFileSync = jest.fn().mockReturnValue(`ID=fedora\nID_LIKE="rhel"\n`);
    fs.accessSync = jest.fn().mockImplementation((p) => {
      if (p === '/var/log/messages') return undefined;
      throw new Error('ENOENT');
    });
    distro = require('../utils/distro');
    const result = distro.resolveLogPath('syslog', undefined);
    expect(result).toBe('/var/log/messages');
  });
});
