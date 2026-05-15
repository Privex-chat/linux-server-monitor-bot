/**
 * Lazily resolved log paths with cross-distro support.
 * Uses env overrides if set, otherwise auto-detects based on distro family.
 * Results are cached after first access.
 */

const config = require('../../config');
const { resolveLogPath, getDistroInfo } = require('./distro');
const logger = require('./logger');

let resolved = null;

function resolve() {
  if (resolved) return resolved;

  const info = getDistroInfo();
  logger.info(`Detected distro: ${info.name} (family: ${info.family})`);

  resolved = {
    auth: resolveLogPath('auth', config.AUTH_LOG),
    syslog: resolveLogPath('syslog', config.SYSLOG_PATH),
    ufw: resolveLogPath('ufw', config.UFW_LOG),
    nginxAccess: config.NGINX_ACCESS_LOG,
    nginxError: config.NGINX_ERROR_LOG,
  };

  // Log resolved paths for debugging
  for (const [key, val] of Object.entries(resolved)) {
    if (val) {
      logger.debug(`Log path [${key}]: ${val}`);
    } else {
      logger.debug(`Log path [${key}]: not found (will skip)`);
    }
  }

  return resolved;
}

module.exports = { resolve };
