/**
 * Cross-distro Linux support.
 * Detects the distribution family and resolves log file paths.
 *
 * Supported families:
 *  - debian  (Debian, Ubuntu, Mint, Pop!_OS, etc.)
 *  - rhel    (RHEL, CentOS, Fedora, Rocky, Alma, Amazon Linux)
 *  - arch    (Arch, Manjaro, EndeavourOS)
 *  - suse    (openSUSE, SLES)
 *  - alpine  (Alpine Linux)
 *  - unknown (fallback — tries Debian paths first)
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

let cachedFamily = null;
let cachedDistroInfo = null;

/**
 * Detect the distro family from /etc/os-release.
 * Cached after first call.
 */
function detectFamily() {
  if (cachedFamily) return cachedFamily;

  try {
    const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
    const idLike = (osRelease.match(/^ID_LIKE=(.*)$/m) || [])[1]?.replace(/"/g, '').toLowerCase() || '';
    const id = (osRelease.match(/^ID=(.*)$/m) || [])[1]?.replace(/"/g, '').toLowerCase() || '';
    const name = (osRelease.match(/^PRETTY_NAME=(.*)$/m) || [])[1]?.replace(/"/g, '') || 'Unknown Linux';

    cachedDistroInfo = { id, idLike, name };

    if (
      ['debian', 'ubuntu', 'mint', 'pop', 'raspbian', 'kali', 'elementary'].includes(id) ||
      idLike.includes('debian') ||
      idLike.includes('ubuntu')
    ) {
      cachedFamily = 'debian';
    } else if (
      ['rhel', 'centos', 'fedora', 'rocky', 'almalinux', 'amzn', 'ol', 'redhat'].includes(id) ||
      idLike.includes('rhel') ||
      idLike.includes('fedora') ||
      idLike.includes('centos')
    ) {
      cachedFamily = 'rhel';
    } else if (['arch', 'manjaro', 'endeavouros', 'artix', 'garuda'].includes(id) || idLike.includes('arch')) {
      cachedFamily = 'arch';
    } else if (['opensuse', 'sles', 'opensuse-leap', 'opensuse-tumbleweed'].includes(id) || idLike.includes('suse')) {
      cachedFamily = 'suse';
    } else if (id === 'alpine') {
      cachedFamily = 'alpine';
    } else {
      cachedFamily = 'unknown';
    }
  } catch {
    // Not Linux or no os-release
    cachedFamily = 'unknown';
    cachedDistroInfo = { id: 'unknown', idLike: '', name: 'Unknown' };
  }

  return cachedFamily;
}

/**
 * Get human-readable distro info.
 */
function getDistroInfo() {
  detectFamily();
  return { ...cachedDistroInfo, family: cachedFamily };
}

/**
 * Check if journalctl is available.
 */
function hasJournalctl() {
  try {
    execFileSync('which', ['journalctl'], { stdio: 'pipe', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the first existing file from a list of candidates.
 */
function findExistingPath(candidates) {
  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return p;
    } catch {
      // continue
    }
  }
  return null;
}

// Log path candidates per distro family
const LOG_PATHS = {
  auth: {
    debian: ['/var/log/auth.log'],
    rhel: ['/var/log/secure'],
    arch: ['/var/log/auth.log', '/var/log/secure'],
    suse: ['/var/log/messages', '/var/log/secure'],
    alpine: ['/var/log/auth.log', '/var/log/messages'],
    unknown: ['/var/log/auth.log', '/var/log/secure', '/var/log/messages'],
  },
  syslog: {
    debian: ['/var/log/syslog'],
    rhel: ['/var/log/messages'],
    arch: ['/var/log/syslog', '/var/log/messages'],
    suse: ['/var/log/messages'],
    alpine: ['/var/log/messages', '/var/log/syslog'],
    unknown: ['/var/log/syslog', '/var/log/messages'],
  },
  ufw: {
    debian: ['/var/log/ufw.log'],
    rhel: ['/var/log/ufw.log'],
    arch: ['/var/log/ufw.log'],
    suse: ['/var/log/ufw.log'],
    alpine: ['/var/log/ufw.log'],
    unknown: ['/var/log/ufw.log'],
  },
};

/**
 * Resolve the correct log path for a given log type.
 * Accepts an env override; falls back to distro-specific detection.
 *
 * @param {'auth'|'syslog'|'ufw'} logType
 * @param {string|undefined} envOverride - Value from env var (if set)
 * @returns {string|null} Resolved path or null if not found
 */
function resolveLogPath(logType, envOverride) {
  if (envOverride) return envOverride;

  const family = detectFamily();
  const candidates = LOG_PATHS[logType]?.[family] || LOG_PATHS[logType]?.unknown || [];
  return findExistingPath(candidates);
}

module.exports = { detectFamily, getDistroInfo, hasJournalctl, resolveLogPath };
