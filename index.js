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

// ── Validate config ──────────────────────────────────────
if (!config.DISCORD_TOKEN || config.DISCORD_TOKEN === 'your_bot_token_here') {
  logger.error('DISCORD_TOKEN is not set. Copy .env.example to .env and add your bot token.');
  process.exit(1);
}

// ── Create Discord client ────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

let intervals = [];
let timeouts = [];
let cronJobs = [];

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
    function scheduleLiveStats() {
      const delay = config.LIVE_INTERVAL_MIN_MS +
        Math.random() * (config.LIVE_INTERVAL_MAX_MS - config.LIVE_INTERVAL_MIN_MS);
      const t = setTimeout(async () => {
        await liveStats.run();
        scheduleLiveStats();
      }, delay);
      timeouts.push(t);
    }
    scheduleLiveStats();

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
    const dailyJob = cron.schedule(config.DAILY_CRON, async () => {
      logger.info('Running daily summary...');
      await summaries.runDaily();
    }, { timezone: 'UTC' });
    cronJobs.push(dailyJob);

    // Weekly summary: Sunday midnight IST
    const weeklyJob = cron.schedule(config.WEEKLY_CRON, async () => {
      logger.info('Running weekly summary...');
      await summaries.runWeekly();
    }, { timezone: 'UTC' });
    cronJobs.push(weeklyJob);

    // Security deep scan: daily at 17:30 IST
    const scanJob = cron.schedule(config.SECURITY_SCAN_CRON, async () => {
      logger.info('Running security deep scan...');
      await securityScan.runAll();
    }, { timezone: 'UTC' });
    cronJobs.push(scanJob);

    logger.info('All tasks scheduled. Bot is fully operational.');
    logger.info(`  Live stats: every ${config.LIVE_INTERVAL_MIN_MS / 1000}-${config.LIVE_INTERVAL_MAX_MS / 1000}s (randomized)`);
    logger.info(`  Security status: every ${config.SECURITY_INTERVAL_MS / 1000}s`);
    logger.info(`  Log watcher: every ${config.LOG_CHECK_INTERVAL_MS / 1000}s`);
    logger.info(`  Daily summary: ${config.DAILY_CRON} (UTC)`);
    logger.info(`  Weekly summary: ${config.WEEKLY_CRON} (UTC)`);
    logger.info(`  Security scan: ${config.SECURITY_SCAN_CRON} (UTC)`);

  } catch (err) {
    logger.error('Setup failed:', err);
    process.exit(1);
  }
});

// ── Error handling ───────────────────────────────────────
client.on('error', (err) => {
  logger.error('Discord client error:', err.message);
});

process.on('unhandledRejection', (err) => {
  logger.error('Unhandled promise rejection:', err);
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err);
  cleanup();
  process.exit(1);
});

// ── Graceful shutdown ────────────────────────────────────
function cleanup() {
  logger.info('Shutting down...');
  for (const interval of intervals) clearInterval(interval);
  for (const t of timeouts) clearTimeout(t);
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
