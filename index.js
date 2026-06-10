const { Client, GatewayIntentBits, Partials } = require('discord.js');
const cron = require('node-cron');
const config = require('./config');
const logger = require('./src/utils/logger');
const { loadState } = require('./src/utils/storage');
const { ensureSetup } = require('./src/setup');
const liveStats = require('./src/tasks/liveStats');
const securityStatus = require('./src/tasks/securityStatus');
const summaries = require('./src/tasks/summaries');
const securityScan = require('./src/tasks/securityScan');
const logWatcher = require('./src/tasks/logWatcher');
const { handleMessage, setAuditThread } = require('./src/commands');
const { validateAlertConfig } = require('./src/utils/alert');

// ── Validate required config ─────────────────────────────
const required = {
  DISCORD_TOKEN: config.DISCORD_TOKEN,
  GUILD_ID: config.GUILD_ID,
};

const missing = Object.entries(required)
  .filter(([, v]) => !v || v === 'your_bot_token_here')
  .map(([k]) => k);

if (missing.length > 0) {
  logger.error(`Missing required env vars: ${missing.join(', ')}. Copy .env.example to .env and fill them in.`);
  process.exit(1);
}

const alertError = validateAlertConfig();
if (alertError) {
  logger.error(alertError);
  process.exit(1);
}

// ── Create Discord client ────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
});

const intervals = [];
const timeouts = [];
const cronJobs = [];

// ── Bot ready ────────────────────────────────────────────
client.once('ready', async () => {
  logger.info(`Logged in as ${client.user.tag}`);
  logger.info(`Guild ID: ${config.GUILD_ID}`);

  try {
    // Load persisted state
    await loadState();

    // Get guild
    const guild = await client.guilds.fetch(config.GUILD_ID);
    if (!guild) {
      logger.error(`Guild ${config.GUILD_ID} not found. Is the bot invited?`);
      process.exit(1);
    }

    logger.info(`Connected to guild: ${guild.name}`);

    // Run setup — create channel, messages, threads
    const resources = await ensureSetup(guild);

    // Wire up audit logging to the commands thread
    if (resources.threads['logs-commands']) {
      setAuditThread(resources.threads['logs-commands']);
    }

    // Initialize all task modules
    liveStats.init(resources);
    securityStatus.init(resources);
    summaries.init(resources);
    securityScan.init(resources);
    logWatcher.init(resources);

    // ── Run initial collection (with a small delay for RAPL baseline) ──
    logger.info('Running initial data collection (power baseline)...');
    await liveStats.run();
    // Wait 3 seconds then run again so RAPL has a delta
    setTimeout(async () => {
      await liveStats.run();
      logger.info('Initial live stats updated.');
    }, 3000);

    // Initial security status
    await securityStatus.run();
    logger.info('Initial security status updated.');

    // Initial log check
    await logWatcher.run();

    // ── Schedule recurring tasks ─────────────────────────

    // Live stats: random 12-15s interval
    let liveStatsTimeout = null;
    const scheduleLiveStats = () => {
      const delay =
        config.LIVE_INTERVAL_MIN_MS + Math.random() * (config.LIVE_INTERVAL_MAX_MS - config.LIVE_INTERVAL_MIN_MS);
      liveStatsTimeout = setTimeout(async () => {
        await liveStats.run();
        scheduleLiveStats();
      }, delay);
    };
    scheduleLiveStats();
    timeouts.push({ clear: () => clearTimeout(liveStatsTimeout) });

    // Security status: every 5 minutes
    const secInterval = setInterval(async () => {
      await securityStatus.run();
    }, config.SECURITY_INTERVAL_MS);
    intervals.push(secInterval);

    // Log watcher: every 30 seconds
    const logInterval = setInterval(async () => {
      await logWatcher.run();
    }, config.LOG_CHECK_INTERVAL_MS);
    intervals.push(logInterval);

    // Daily summary: midnight IST
    const dailyJob = cron.schedule(
      config.DAILY_CRON,
      async () => {
        logger.info('Running daily summary...');
        await summaries.runDaily();
      },
      { timezone: config.TIMEZONE }
    );
    cronJobs.push(dailyJob);

    // Weekly summary: Sunday midnight IST
    const weeklyJob = cron.schedule(
      config.WEEKLY_CRON,
      async () => {
        logger.info('Running weekly summary...');
        await summaries.runWeekly();
      },
      { timezone: config.TIMEZONE }
    );
    cronJobs.push(weeklyJob);

    // Security deep scan: daily at 17:30 IST
    const scanJob = cron.schedule(
      config.SECURITY_SCAN_CRON,
      async () => {
        logger.info('Running security deep scan...');
        await securityScan.runAll();
      },
      { timezone: config.TIMEZONE }
    );
    cronJobs.push(scanJob);

    logger.info('All tasks scheduled. Bot is fully operational.');
    logger.info(
      `  Live stats: every ${config.LIVE_INTERVAL_MIN_MS / 1000}-${config.LIVE_INTERVAL_MAX_MS / 1000}s (randomized)`
    );
    logger.info(`  Security status: every ${config.SECURITY_INTERVAL_MS / 1000}s`);
    logger.info(`  Log watcher: every ${config.LOG_CHECK_INTERVAL_MS / 1000}s`);
    logger.info(`  Daily summary: ${config.DAILY_CRON} (${config.TIMEZONE})`);
    logger.info(`  Weekly summary: ${config.WEEKLY_CRON} (${config.TIMEZONE})`);
    logger.info(`  Security scan: ${config.SECURITY_SCAN_CRON} (${config.TIMEZONE})`);
  } catch (err) {
    logger.error(err, 'Setup failed');
    process.exit(1);
  }
});

// ── Command handler ──────────────────────────────────────
client.on('messageCreate', handleMessage);

// ── Error handling ───────────────────────────────────────
client.on('error', (err) => {
  logger.error(`Discord client error: ${err.message}`);
});

process.on('unhandledRejection', (err) => {
  logger.error(err, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.error(err, 'Uncaught exception');
  cleanup();
  process.exit(1);
});

// ── Graceful shutdown ────────────────────────────────────
function cleanup() {
  logger.info('Shutting down...');
  for (const interval of intervals) clearInterval(interval);
  for (const t of timeouts) {
    if (t && typeof t.clear === 'function') t.clear();
    else clearTimeout(t);
  }
  for (const job of cronJobs) job.stop();
  client.destroy();
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});

// ── Login ────────────────────────────────────────────────
client.login(config.DISCORD_TOKEN);
