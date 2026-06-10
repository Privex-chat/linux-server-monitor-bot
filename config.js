require('dotenv').config();

module.exports = {
  // ── Discord (required — set in .env) ─────────────────────
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  GUILD_ID: process.env.GUILD_ID,
  CHANNEL_NAME: process.env.CHANNEL_NAME || 'server-monitor',
  ALERT_USER_ID: process.env.ALERT_USER_ID || null,
  ALERT_ROLE_ID: process.env.ALERT_ROLE_ID || null,
  OWNER_IDS: process.env.OWNER_IDS
    ? process.env.OWNER_IDS.split(',').map((s) => s.trim())
    : process.env.ALERT_USER_ID
      ? [process.env.ALERT_USER_ID]
      : [],
  SUDO_ROLE_NAME: process.env.SUDO_ROLE_NAME || 'sudo',

  // ── Intervals ────────────────────────────────────────────
  LIVE_INTERVAL_MIN_MS: 12 * 1000,
  LIVE_INTERVAL_MAX_MS: 15 * 1000,
  SECURITY_INTERVAL_MS: 5 * 60 * 1000,
  LOG_CHECK_INTERVAL_MS: 30 * 1000,

  // ── Cron (UTC — adjust for your timezone) ────────────────
  DAILY_CRON: process.env.DAILY_CRON || '30 18 * * *',
  WEEKLY_CRON: process.env.WEEKLY_CRON || '30 18 * * 0',
  SECURITY_SCAN_CRON: process.env.SECURITY_SCAN_CRON || '0 12 * * *',

  // ── Timezone ─────────────────────────────────────────────
  TIMEZONE: process.env.TIMEZONE || 'UTC',

  // ── Logging ─────────────────────────────────────────────
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // ── Power ────────────────────────────────────────────────
  // Base system load in watts — everything RAPL doesn't measure
  // (motherboard, fans, RAM, drives). Adjust for your hardware.
  POWER_BASE_LOAD_W: parseInt(process.env.POWER_BASE_LOAD_W) || 33,
  PSU_WATTAGE: parseInt(process.env.PSU_WATTAGE) || 450,

  // ── Security thresholds ──────────────────────────────────
  SSH_FAIL_WARN_THRESHOLD: parseInt(process.env.SSH_FAIL_WARN_THRESHOLD, 10) || 10,
  SSH_FAIL_CRIT_THRESHOLD: parseInt(process.env.SSH_FAIL_CRIT_THRESHOLD, 10) || 50,
  EXPECTED_PORTS: process.env.EXPECTED_PORTS
    ? process.env.EXPECTED_PORTS.split(',')
        .map((p) => parseInt(p.trim(), 10))
        .filter(Number.isInteger)
    : [22, 53, 80, 443],

  // Noise-aware security windows. Cumulative internet scanner noise is
  // summarized, while recent spikes and missing protections still alert.
  SECURITY_ALERT_COOLDOWN_MS: parseInt(process.env.SECURITY_ALERT_COOLDOWN_MS, 10) || 30 * 60 * 1000,
  SECURITY_EVENT_RETENTION_MS: parseInt(process.env.SECURITY_EVENT_RETENTION_MS, 10) || 60 * 60 * 1000,
  SSH_FAIL_WINDOW_MS: parseInt(process.env.SSH_FAIL_WINDOW_MS, 10) || 15 * 60 * 1000,
  SSH_FAIL_WINDOW_WARN_THRESHOLD: parseInt(process.env.SSH_FAIL_WINDOW_WARN_THRESHOLD, 10) || 40,
  SSH_FAIL_WINDOW_CRIT_THRESHOLD: parseInt(process.env.SSH_FAIL_WINDOW_CRIT_THRESHOLD, 10) || 150,
  SSH_FAIL_PER_IP_WARN_THRESHOLD: parseInt(process.env.SSH_FAIL_PER_IP_WARN_THRESHOLD, 10) || 15,
  SSH_FAIL_PER_IP_CRIT_THRESHOLD: parseInt(process.env.SSH_FAIL_PER_IP_CRIT_THRESHOLD, 10) || 60,
  UFW_BLOCK_BATCH_WARN_THRESHOLD: parseInt(process.env.UFW_BLOCK_BATCH_WARN_THRESHOLD, 10) || 250,
  UFW_BLOCK_BATCH_CRIT_THRESHOLD: parseInt(process.env.UFW_BLOCK_BATCH_CRIT_THRESHOLD, 10) || 1000,
  NGINX_ATTACK_BATCH_WARN_THRESHOLD: parseInt(process.env.NGINX_ATTACK_BATCH_WARN_THRESHOLD, 10) || 25,
  NGINX_ATTACK_BATCH_CRIT_THRESHOLD: parseInt(process.env.NGINX_ATTACK_BATCH_CRIT_THRESHOLD, 10) || 100,

  // ── Watched processes (comma-separated in .env) ──────────
  WATCHED_PM2_IDS: process.env.WATCHED_PM2_IDS ? process.env.WATCHED_PM2_IDS.split(',').map(Number) : [],
  WATCHED_DOCKER_IDS: process.env.WATCHED_DOCKER_IDS
    ? process.env.WATCHED_DOCKER_IDS.split(',').map((s) => s.trim())
    : [],

  // ── PM2 ──────────────────────────────────────────────────
  PM2_USER: process.env.PM2_USER || '',

  // ── Log paths (auto-detected per distro, override via env) ─
  AUTH_LOG: process.env.AUTH_LOG || null, // auto: /var/log/auth.log (Debian) or /var/log/secure (RHEL)
  SYSLOG_PATH: process.env.SYSLOG_PATH || null, // auto: /var/log/syslog (Debian) or /var/log/messages (RHEL)
  UFW_LOG: process.env.UFW_LOG || null, // auto: /var/log/ufw.log
  NGINX_ACCESS_LOG: process.env.NGINX_ACCESS_LOG || '/var/log/nginx/access.log',
  NGINX_ERROR_LOG: process.env.NGINX_ERROR_LOG || '/var/log/nginx/error.log',

  // ── State persistence ────────────────────────────────────
  STATE_FILE: './data/state.json',

  // ── Limits ────────────────────────────────────────────────
  MAX_DISCORD_MSG_LENGTH: 1900,
  COMMAND_TIMEOUT_MS: 5000,
  COMMAND_TIMEOUT_LONG_MS: 30000,
  LOG_TAIL_MAX_BYTES: 50000,
  MAX_DAILY_SAMPLES: 1500,

  // ── Rate limiting (milliseconds) ─────────────────────────
  COOLDOWN_DEFAULT_MS: 3000,
  COOLDOWN_DANGEROUS_MS: 30000,
  COOLDOWN_HEAVY_MS: 10000,
  ENABLE_REMOTE_SHELL: process.env.ENABLE_REMOTE_SHELL === 'true',

  // ── Embed colors ─────────────────────────────────────────
  COLORS: {
    GREEN: 0x2ecc71,
    YELLOW: 0xf1c40f,
    ORANGE: 0xe67e22,
    RED: 0xe74c3c,
    BLUE: 0x3498db,
    PURPLE: 0x9b59b6,
    CYAN: 0x00bcd4,
    DARK: 0x2c2f33,
  },
};
