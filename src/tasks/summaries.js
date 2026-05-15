const embeds = require('../formatters/embeds');
const { updateState, getState } = require('../utils/storage');
const logger = require('../utils/logger');

let resources = null;

function init(res) {
  resources = res;
}

async function runDaily() {
  if (!resources) return;

  try {
    const state = getState();
    const data = { ...state.dailyAccumulator };

    if (data.cpuSamples.length === 0) {
      logger.info('No daily data to summarize.');
      return;
    }

    // Build and post daily summary
    const embed = embeds.buildDailySummaryEmbed(data);
    const messageId = state.messageIds.dailySummary;
    if (messageId) {
      const msg = await resources.channel.messages.fetch(messageId);
      await msg.edit({ content: null, embeds: [embed] });
    }

    // Store snapshot for weekly accumulator
    await updateState((s) => {
      if (!s.weeklyAccumulator.startTime) {
        s.weeklyAccumulator.startTime = new Date().toISOString();
      }
      s.weeklyAccumulator.dailySummaries.push({
        date: new Date().toISOString(),
        cpuSamples: data.cpuSamples,
        ramSamples: data.ramSamples,
        powerSamples: data.powerSamples,
        tempSamples: data.tempSamples,
        peakCpu: data.peakCpu,
        peakRam: data.peakRam,
        peakPower: data.peakPower,
        peakTemp: data.peakTemp,
        networkInTotal: data.networkInTotal,
        networkOutTotal: data.networkOutTotal,
      });

      // Reset daily accumulator
      s.dailyAccumulator = {
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
        startTime: new Date().toISOString(),
      };
      s.lastDailySummary = new Date().toISOString();
    });

    logger.info('Daily summary generated.');
  } catch (err) {
    logger.error(`Daily summary error: ${err.message}`);
  }
}

async function runWeekly() {
  if (!resources) return;

  try {
    const state = getState();
    const data = { ...state.weeklyAccumulator };

    if (data.dailySummaries.length === 0) {
      logger.info('No weekly data to summarize.');
      return;
    }

    const embed = embeds.buildWeeklySummaryEmbed(data);
    const messageId = state.messageIds.weeklySummary;
    if (messageId) {
      const msg = await resources.channel.messages.fetch(messageId);
      await msg.edit({ content: null, embeds: [embed] });
    }

    // Reset weekly accumulator
    await updateState((s) => {
      s.weeklyAccumulator = {
        dailySummaries: [],
        startTime: new Date().toISOString(),
      };
      s.lastWeeklySummary = new Date().toISOString();
    });

    logger.info('Weekly summary generated.');
  } catch (err) {
    logger.error(`Weekly summary error: ${err.message}`);
  }
}

module.exports = { init, runDaily, runWeekly };
