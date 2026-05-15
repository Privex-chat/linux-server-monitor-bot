const fs = require('fs').promises;
const path = require('path');
const config = require('../../config');
const logger = require('./logger');

const STATE_PATH = path.resolve(config.STATE_FILE);

let stateCache = null;

const DEFAULT_STATE = {
  channelId: null,
  messageIds: {
    liveStats: null,
    dailySummary: null,
    weeklySummary: null,
    pm2Status: null,
    dockerStatus: null,
    securityStatus: null,
  },
  threadIds: {
    'logs-system': null,
    'logs-docker': null,
    'logs-pm2': null,
    'logs-auth': null,
    'logs-security': null,
    'logs-nginx': null,
    'logs-power': null,
  },
  logOffsets: {
    auth: 0,
    syslog: 0,
    nginx_access: 0,
    nginx_error: 0,
    ufw: 0,
  },
  dailyAccumulator: {
    cpuSamples: [],
    ramSamples: [],
    powerSamples: [],
    tempSamples: [],
    networkInTotal: 0,
    networkOutTotal: 0,
    peakCpu: 0,
    peakRam: 0,
    peakPower: 0,
    peakTemp: 0,
    startTime: null,
  },
  weeklyAccumulator: {
    dailySummaries: [],
    startTime: null,
  },
  lastSecurityScan: null,
  lastDailySummary: null,
  lastWeeklySummary: null,
};

async function loadState() {
  try {
    const dir = path.dirname(STATE_PATH);
    await fs.mkdir(dir, { recursive: true });
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    stateCache = JSON.parse(raw);

    // Deep-merge with defaults so new keys are always present
    for (const section of ['messageIds', 'threadIds', 'logOffsets', 'dailyAccumulator', 'weeklyAccumulator']) {
      stateCache[section] = { ...DEFAULT_STATE[section], ...(stateCache[section] || {}) };
    }
    for (const key of Object.keys(DEFAULT_STATE)) {
      if (!(key in stateCache)) stateCache[key] = DEFAULT_STATE[key];
    }
  } catch {
    stateCache = JSON.parse(JSON.stringify(DEFAULT_STATE));
    stateCache.dailyAccumulator.startTime = new Date().toISOString();
    stateCache.weeklyAccumulator.startTime = new Date().toISOString();
    await saveState();
  }
  return stateCache;
}

async function saveState() {
  try {
    const dir = path.dirname(STATE_PATH);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(STATE_PATH, JSON.stringify(stateCache, null, 2), 'utf8');
  } catch (err) {
    logger.error('Failed to save state:', err.message);
  }
}

function getState() {
  return stateCache || JSON.parse(JSON.stringify(DEFAULT_STATE));
}

async function updateState(updater) {
  if (!stateCache) await loadState();
  updater(stateCache);
  await saveState();
}

module.exports = { loadState, saveState, getState, updateState };
