const { ChannelType, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const { updateState, getState } = require('./utils/storage');
const logger = require('./utils/logger');

const MESSAGES_ORDER = [
  { key: 'liveStats', label: '📡 Live Stats — initializing...' },
  { key: 'dailySummary', label: '📊 Daily Summary — initializing...' },
  { key: 'weeklySummary', label: '📈 Weekly Summary — initializing...' },
  { key: 'pm2Status', label: '🖥️ PM2 Status — initializing...' },
  { key: 'dockerStatus', label: '🐳 Docker Status — initializing...' },
  { key: 'securityStatus', label: '🛡️ Security Status — initializing...' },
];

const THREADS = [
  { key: 'logs-system', name: '📋 logs-system' },
  { key: 'logs-docker', name: '📋 logs-docker' },
  { key: 'logs-pm2', name: '📋 logs-pm2' },
  { key: 'logs-auth', name: '📋 logs-auth' },
  { key: 'logs-security', name: '📋 logs-security' },
  { key: 'logs-nginx', name: '📋 logs-nginx' },
  { key: 'logs-power', name: '📋 logs-power' },
];

/**
 * Ensures the monitor channel, placeholder messages, and log threads all exist.
 * Creates anything missing. Returns { channel, messages, threads }.
 */
async function ensureSetup(guild) {
  const state = getState();

  // ── 1. Find or create the channel ──
  let channel = null;

  if (state.channelId) {
    try {
      channel = await guild.channels.fetch(state.channelId);
    } catch {
      logger.warn('Stored channel not found, will create a new one.');
      channel = null;
    }
  }

  if (!channel) {
    channel = guild.channels.cache.find(
      (ch) => ch.name === config.CHANNEL_NAME && ch.type === ChannelType.GuildText
    );
  }

  if (!channel) {
    logger.info(`Creating channel #${config.CHANNEL_NAME}...`);
    channel = await guild.channels.create({
      name: config.CHANNEL_NAME,
      type: ChannelType.GuildText,
      topic: '🖥️ Ubuntu Server Monitor — live stats, logs, and security alerts',
      reason: 'Server Monitor Bot setup',
    });
  }

  await updateState((s) => {
    s.channelId = channel.id;
  });

  // ── 2. Ensure placeholder messages exist (in order) ──
  const messages = {};

  for (const { key, label } of MESSAGES_ORDER) {
    let msg = null;

    if (state.messageIds[key]) {
      try {
        msg = await channel.messages.fetch(state.messageIds[key]);
      } catch {
        logger.warn(`Message for ${key} not found, re-creating.`);
        msg = null;
      }
    }

    if (!msg) {
      msg = await channel.send({ content: label });
      await updateState((s) => {
        s.messageIds[key] = msg.id;
      });
      logger.info(`Created placeholder message for ${key} (${msg.id})`);
    }

    messages[key] = msg;
  }

  // ── 3. Ensure log threads exist ──
  const threads = {};

  // Fetch active and archived threads
  const activeThreads = channel.threads.cache;
  let archivedThreads = new Map();
  try {
    const fetched = await channel.threads.fetchArchived({ limit: 20 });
    archivedThreads = fetched.threads;
  } catch {
    /* may not have permission */
  }

  for (const { key, name } of THREADS) {
    let thread = null;

    if (state.threadIds[key]) {
      try {
        thread = await channel.threads.fetch(state.threadIds[key]);
        // Unarchive if archived
        if (thread && thread.archived) {
          await thread.setArchived(false);
        }
      } catch {
        thread = null;
      }
    }

    if (!thread) {
      // Search by name in active and archived
      thread =
        activeThreads.find((t) => t.name === name) ||
        archivedThreads.find((t) => t.name === name) ||
        null;

      if (thread && thread.archived) {
        await thread.setArchived(false);
      }
    }

    if (!thread) {
      logger.info(`Creating thread: ${name}...`);
      thread = await channel.threads.create({
        name,
        autoArchiveDuration: 10080, // 7 days
        type: ChannelType.PublicThread,
        reason: 'Server Monitor Bot — log thread',
      });
      await thread.send(`📋 **${key}** — log entries will appear here.`);
    }

    await updateState((s) => {
      s.threadIds[key] = thread.id;
    });
    threads[key] = thread;
  }

  logger.info('Setup complete. Channel, messages, and threads verified.');
  return { channel, messages, threads };
}

module.exports = { ensureSetup };
