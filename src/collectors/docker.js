const { safeExec } = require('../utils/exec');
const config = require('../../config');

async function getDockerStatus() {
  const result = {
    available: false,
    containers: [],
    watched: [],
  };

  const { stdout, success } = await safeExec('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 15000 });
  if (!success) return result;

  result.available = true;
  const lines = stdout.trim().split('\n').filter(Boolean);

  for (const line of lines) {
    try {
      const c = JSON.parse(line);
      const info = {
        id: c.ID,
        name: c.Names,
        image: c.Image,
        status: c.Status,
        state: c.State,
        ports: c.Ports || '',
        created: c.CreatedAt,
        watched: config.WATCHED_DOCKER_IDS.some((wid) => c.ID.startsWith(wid)),
        cpuPercent: null,
        memUsage: null,
        memPercent: null,
        netIO: null,
        blockIO: null,
      };
      result.containers.push(info);
      if (info.watched) result.watched.push(info);
    } catch {
      /* skip malformed */
    }
  }

  // Resource usage for running containers
  const statsResult = await safeExec('docker', ['stats', '--no-stream', '--format', '{{json .}}'], { timeout: 15000 });
  if (statsResult.success) {
    const statsLines = statsResult.stdout.trim().split('\n').filter(Boolean);
    for (const sl of statsLines) {
      try {
        const s = JSON.parse(sl);
        const container = result.containers.find((c) => c.id === s.ID || c.name === s.Name);
        if (container) {
          container.cpuPercent = s.CPUPerc;
          container.memUsage = s.MemUsage;
          container.memPercent = s.MemPerc;
          container.netIO = s.NetIO;
          container.blockIO = s.BlockIO;
        }
      } catch {
        /* skip */
      }
    }
  }

  return result;
}

async function getDockerLogs(containerIdOrName, lines = 30) {
  const { stdout, success } = await safeExec('docker', ['logs', '--tail', String(lines), containerIdOrName], {
    timeout: 10000,
  });
  return success ? stdout.trim() : '';
}

module.exports = { getDockerStatus, getDockerLogs };
