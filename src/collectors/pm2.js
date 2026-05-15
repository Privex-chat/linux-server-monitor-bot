const { safeExec } = require('../utils/exec');
const config = require('../../config');
const logger = require('../utils/logger');

async function getPm2Status() {
  const result = {
    available: false,
    processes: [],
    watched: [],
  };

  const { stdout, success } = await safeExec('pm2', ['jlist'], { timeout: 15000 });
  if (!success) return result;

  try {
    const processes = JSON.parse(stdout);
    result.available = true;

    for (const proc of processes) {
      const info = {
        id: proc.pm_id,
        name: proc.name,
        status: proc.pm2_env?.status || 'unknown',
        cpu: proc.monit?.cpu || 0,
        memory: proc.monit?.memory || 0,
        restarts: proc.pm2_env?.restart_time || 0,
        uptime: proc.pm2_env?.pm_uptime ? Date.now() - proc.pm2_env.pm_uptime : 0,
        pid: proc.pid,
        watched: config.WATCHED_PM2_IDS.includes(proc.pm_id),
      };

      result.processes.push(info);
      if (info.watched) result.watched.push(info);
    }
  } catch (e) {
    logger.error(`Failed to parse PM2 output: ${e.message}`);
  }

  return result;
}

async function getPm2Logs(processNameOrId, lines = 20) {
  const { stdout, success } = await safeExec(
    'pm2',
    ['logs', String(processNameOrId), '--lines', String(lines), '--nostream', '--raw'],
    { timeout: 10000 }
  );
  return success ? stdout.trim() : '';
}

module.exports = { getPm2Status, getPm2Logs };
