require('dotenv').config();

module.exports = {
  // ── Discord ──────────────────────────────────────────────
  DISCORD_TOKEN: process.env.DISCORD_TOKEN,
  GUILD_ID: process.env.GUILD_ID || '1498377364231422106',
  CHANNEL_NAME: process.env.CHANNEL_NAME || 'server-monitor',
  ALERT_USER_ID: process.env.ALERT_USER_ID || '1053965380957241344',
  SUDO_ROLE_NAME: process.env.SUDO_ROLE_NAME || 'sudo',

  // ── Intervals ────────────────────────────────────────────
  LIVE_INTERVAL_MIN_MS: 12 * 1000,      // 12 seconds minimum
  LIVE_INTERVAL_MAX_MS: 15 * 1000,      // 15 seconds maximum
  SECURITY_INTERVAL_MS: 5 * 60 * 1000,  // 5 minutes
  LOG_CHECK_INTERVAL_MS: 30 * 1000,     // 30 seconds

  // ── Cron (server runs in UTC, these fire at IST midnight/etc) ──
  DAILY_CRON: '30 18 * * *',            // 00:00 IST = 18:30 UTC prev day
  WEEKLY_CRON: '30 18 * * 0',           // Sunday 00:00 IST
  SECURITY_SCAN_CRON: '0 12 * * *',     // 17:30 IST daily deep scan

  // ── Timezone ─────────────────────────────────────────────
  TIMEZONE: 'Asia/Kolkata',

  // ── Power ────────────────────────────────────────────────
  // Base system load in watts (motherboard ~20W, fans ~3W, RAM 16GB ~4W, HDD ~6W)
  // RAPL only measures CPU/DRAM; this covers everything else
  POWER_BASE_LOAD_W: 33,
  PSU_WATTAGE: 450,

  // ── Security thresholds ──────────────────────────────────
  SSH_FAIL_WARN_THRESHOLD: 10,
  SSH_FAIL_CRIT_THRESHOLD: 50,
  EXPECTED_PORTS: [
    22,    // SSH
    53,    // DNS
    80,    // HTTP
    443,   // HTTPS
    4330,  // Custom service
    5432,  // PostgreSQL
    5433,  // PostgreSQL (alt)
    6379,  // Redis
    8000,  // Web app
    8080,  // Web app
    8081,  // Web app
    9090,  // Monitoring / web UI
    15279, // Custom service
    20241, // Custom service
    44321, // Custom service
    44322, // Custom service
    44323, // Custom service
  ],

  // ── Watched processes ────────────────────────────────────
  WATCHED_PM2_IDS: [1, 2],
  WATCHED_DOCKER_IDS: ['df0514b4c944', '7f98311dfbbd', '2c4ccfc9f9fd'],

  // ── PM2 ──────────────────────────────────────────────────
  PM2_USER: 'sonix',

  // ── Nginx log paths ──────────────────────────────────────
  NGINX_ACCESS_LOG: '/var/log/nginx/access.log',
  NGINX_ERROR_LOG: '/var/log/nginx/error.log',

  // ── State persistence ────────────────────────────────────
  STATE_FILE: './data/state.json',

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
