const systemCollector = require('../collectors/system');
const tempCollector = require('../collectors/temperature');
const powerCollector = require('../collectors/power');
const pm2Collector = require('../collectors/pm2');
const dockerCollector = require('../collectors/docker');
const securityCollector = require('../collectors/security');
const embeds = require('../formatters/embeds');
const { updateState, getState } = require('../utils/storage');
const logger = require('../utils/logger');

let resources = null; // { channel, messages, threads }

function init(res) {
  resources = res;
}

async function run() {
  if (!resources) return;

  try {
    // Collect all metrics in parallel
    const [system, temps, power, pm2Data, dockerData] = await Promise.all([
      systemCollector.collectAll(),
      tempCollector.getTemperatures(),
      powerCollector.getPowerUsage(),
      pm2Collector.getPm2Status(),
      dockerCollector.getDockerStatus(),
    ]);

    // Build embeds
    const liveEmbed = embeds.buildLiveStatsEmbed(system, temps, power);
    const pm2Embed = embeds.buildPm2Embed(pm2Data);
    const dockerEmbed = embeds.buildDockerEmbed(dockerData);

    // Edit messages
    const state = getState();

    await editMessage(resources.channel, state.messageIds.liveStats, liveEmbed);
    await editMessage(resources.channel, state.messageIds.pm2Status, pm2Embed);
    await editMessage(resources.channel, state.messageIds.dockerStatus, dockerEmbed);

    // Accumulate data for daily/weekly summaries
    await updateState((s) => {
      if (!s.dailyAccumulator.startTime) {
        s.dailyAccumulator.startTime = new Date().toISOString();
      }

      s.dailyAccumulator.cpuSamples.push(system.cpu.total);

      const memPct = system.memory.total > 0
        ? (system.memory.used / system.memory.total) * 100
        : 0;
      s.dailyAccumulator.ramSamples.push(Math.round(memPct * 10) / 10);

      if (power.available) {
        s.dailyAccumulator.powerSamples.push(power.estimatedTotal);
        s.dailyAccumulator.peakPower = Math.max(s.dailyAccumulator.peakPower, power.estimatedTotal);
      }

      if (temps.cpu.package !== null) {
        s.dailyAccumulator.tempSamples.push(temps.cpu.package);
        s.dailyAccumulator.peakTemp = Math.max(s.dailyAccumulator.peakTemp, temps.cpu.package);
      }

      s.dailyAccumulator.peakCpu = Math.max(s.dailyAccumulator.peakCpu, system.cpu.total);
      s.dailyAccumulator.peakRam = Math.max(s.dailyAccumulator.peakRam, memPct);

      // Network totals (approximate from speed × interval)
      const iface = system.network.interfaces[0];
      if (iface) {
        // rxSpeed/txSpeed are in Mbps, interval is ~60s
        s.dailyAccumulator.networkInTotal += (iface.rxSpeed * 60 * 1e6) / 8;
        s.dailyAccumulator.networkOutTotal += (iface.txSpeed * 60 * 1e6) / 8;
      }

      // Keep sample arrays from growing unbounded (max ~1500 = 24h at 1/min + buffer)
      const maxSamples = 1500;
      for (const key of ['cpuSamples', 'ramSamples', 'powerSamples', 'tempSamples']) {
        if (s.dailyAccumulator[key].length > maxSamples) {
          s.dailyAccumulator[key] = s.dailyAccumulator[key].slice(-maxSamples);
        }
      }
    });

    logger.debug('Live stats updated.');
  } catch (err) {
    logger.error('Live stats error:', err.message);
  }
}

async function editMessage(channel, messageId, embed) {
  if (!messageId) return;
  try {
    const msg = await channel.messages.fetch(messageId);
    await msg.edit({ content: null, embeds: [embed] });
  } catch (err) {
    logger.warn(`Failed to edit message ${messageId}:`, err.message);
  }
}

module.exports = { init, run };
