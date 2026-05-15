const { readProcFile } = require('../utils/exec');
const config = require('../../config');
const logger = require('../utils/logger');
const fs = require('fs').promises;

const RAPL_BASE = '/sys/class/powercap';
let prevReadings = null;
let prevTime = null;

async function discoverRaplDomains() {
  const domains = [];

  try {
    const entries = await fs.readdir(RAPL_BASE);
    for (const entry of entries) {
      if (!entry.startsWith('intel-rapl:')) continue;

      const domainPath = `${RAPL_BASE}/${entry}`;
      const nameResult = await readProcFile(`${domainPath}/name`);
      const name = nameResult.success ? nameResult.content.trim() : entry;
      domains.push({ path: domainPath, name, id: entry });

      // Sub-domains (core, uncore, dram)
      try {
        const subEntries = await fs.readdir(domainPath);
        for (const sub of subEntries) {
          if (!sub.startsWith('intel-rapl:')) continue;
          const subPath = `${domainPath}/${sub}`;
          const subNameResult = await readProcFile(`${subPath}/name`);
          const subName = subNameResult.success ? subNameResult.content.trim() : sub;
          domains.push({ path: subPath, name: subName, id: sub });
        }
      } catch {
        /* no sub-domains */
      }
    }
  } catch (e) {
    logger.warn(`RAPL not available: ${e.message}`);
  }

  return domains;
}

async function getPowerUsage() {
  const result = {
    available: false,
    package: 0,
    core: 0,
    uncore: 0,
    dram: 0,
    totalRapl: 0,
    estimatedTotal: 0,
    psuPercent: 0,
    domains: [],
  };

  const domains = await discoverRaplDomains();
  if (domains.length === 0) return result;

  const now = Date.now();
  const currentReadings = {};

  for (const domain of domains) {
    const energyResult = await readProcFile(`${domain.path}/energy_uj`);
    if (energyResult.success) {
      const energy = parseInt(energyResult.content.trim(), 10);
      if (!Number.isNaN(energy)) {
        currentReadings[domain.id] = {
          energy,
          name: domain.name,
          path: domain.path,
        };
      }
    }
  }

  if (prevReadings && prevTime) {
    const elapsed = (now - prevTime) / 1000;
    if (elapsed > 0) {
      result.available = true;

      for (const [id, curr] of Object.entries(currentReadings)) {
        const prev = prevReadings[id];
        if (!prev) continue;

        let energyDelta = curr.energy - prev.energy;

        // Handle counter overflow
        if (energyDelta < 0) {
          const maxPath = `${curr.path}/max_energy_range_uj`;
          const maxResult = await readProcFile(maxPath);
          const maxEnergy = maxResult.success ? parseInt(maxResult.content.trim(), 10) : NaN;
          if (!Number.isNaN(maxEnergy)) {
            energyDelta = maxEnergy - prev.energy + curr.energy;
          } else {
            // Fallback if maxEnergy is unavailable but counter wrapped
            energyDelta = curr.energy;
          }
        }

        let watts = energyDelta / 1e6 / elapsed;
        if (Number.isNaN(watts) || watts < 0) watts = 0;

        const name = curr.name.toLowerCase();

        if (name.includes('package')) {
          result.package = Math.round(watts * 10) / 10;
        } else if (name === 'core') {
          result.core = Math.round(watts * 10) / 10;
        } else if (name === 'uncore') {
          result.uncore = Math.round(watts * 10) / 10;
        } else if (name === 'dram') {
          result.dram = Math.round(watts * 10) / 10;
        }

        result.domains.push({ name: curr.name, watts: Math.round(watts * 10) / 10 });
      }

      result.package = Number.isNaN(result.package) ? 0 : result.package;
      result.dram = Number.isNaN(result.dram) ? 0 : result.dram;

      result.totalRapl = Math.round((result.package + result.dram) * 10) / 10;
      // Estimate total system power: base load (mobo, fans, RAM, drives) + RAPL
      const baseLoad = config.POWER_BASE_LOAD_W || 33;
      const psuWattage = config.PSU_WATTAGE || 450;
      result.estimatedTotal = Math.round((baseLoad + result.totalRapl) * 10) / 10;
      result.psuPercent = Math.round((result.estimatedTotal / psuWattage) * 1000) / 10;
    }
  }

  prevReadings = currentReadings;
  prevTime = now;

  return result;
}

module.exports = { getPowerUsage };
