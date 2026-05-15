const { safeExec, readProcFile } = require('../utils/exec');

let prevCpuInfo = null;
let prevNetInfo = null;
let prevNetTime = null;

async function getCpuUsage() {
  const { content, success } = await readProcFile('/proc/stat');
  if (!success) return { total: 0, cores: [], loadAvg: 'N/A' };

  const lines = content.trim().split('\n');
  const cpuLines = lines.filter((l) => l.startsWith('cpu'));

  const parseLine = (line) => {
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  };

  const current = {};
  for (const line of cpuLines) {
    const name = line.split(/\s+/)[0];
    current[name] = parseLine(line);
  }

  let totalUsage = 0;
  const coreUsages = [];

  if (prevCpuInfo) {
    const prev = prevCpuInfo['cpu'];
    const curr = current['cpu'];
    const totalDelta = curr.total - prev.total;
    const idleDelta = curr.idle - prev.idle;
    totalUsage = totalDelta > 0 ? ((totalDelta - idleDelta) / totalDelta) * 100 : 0;

    for (const key of Object.keys(current)) {
      if (key === 'cpu') continue;
      if (prevCpuInfo[key]) {
        const p = prevCpuInfo[key];
        const c = current[key];
        const td = c.total - p.total;
        const id = c.idle - p.idle;
        coreUsages.push(td > 0 ? ((td - id) / td) * 100 : 0);
      }
    }
  }

  prevCpuInfo = current;

  const loadResult = await readProcFile('/proc/loadavg');
  const loadAvg = loadResult.success
    ? loadResult.content.trim().split(/\s+/).slice(0, 3).join(' / ')
    : 'N/A';

  return { total: Math.round(totalUsage * 10) / 10, cores: coreUsages, loadAvg };
}

async function getMemoryUsage() {
  const { stdout, success } = await safeExec('free', ['-b']);
  if (!success) return { total: 0, used: 0, available: 0, swapTotal: 0, swapUsed: 0 };

  const lines = stdout.trim().split('\n');
  const memLine = lines[1]?.trim().split(/\s+/);
  const swapLine = lines[2]?.trim().split(/\s+/);

  return {
    total: parseInt(memLine?.[1] || 0),
    used: parseInt(memLine?.[2] || 0),
    available: parseInt(memLine?.[6] || memLine?.[3] || 0),
    swapTotal: parseInt(swapLine?.[1] || 0),
    swapUsed: parseInt(swapLine?.[2] || 0),
  };
}

async function getDiskUsage() {
  const { stdout, success } = await safeExec('df', ['-B1', '--output=source,fstype,size,used,avail,pcent,target']);
  if (!success) return [];

  const lines = stdout.trim().split('\n').slice(1);
  const disks = [];
  const realFs = ['ext4', 'ext3', 'xfs', 'btrfs', 'zfs', 'ntfs', 'vfat', 'fuseblk'];

  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 7) continue;
    if (!realFs.includes(parts[1])) continue;

    disks.push({
      device: parts[0],
      fstype: parts[1],
      total: parseInt(parts[2]),
      used: parseInt(parts[3]),
      available: parseInt(parts[4]),
      percent: parts[5],
      mount: parts.slice(6).join(' '),
    });
  }

  return disks;
}

async function getNetworkUsage() {
  const { content, success } = await readProcFile('/proc/net/dev');
  if (!success) return { interfaces: [] };

  const lines = content.trim().split('\n').slice(2);
  const now = Date.now();
  const current = {};
  const interfaces = [];

  for (const line of lines) {
    const parts = line.trim().split(/[\s:]+/);
    const name = parts[0];
    if (name === 'lo') continue;

    const rxBytes = parseInt(parts[1]);
    const txBytes = parseInt(parts[9]);
    current[name] = { rxBytes, txBytes };

    let rxSpeed = 0;
    let txSpeed = 0;
    if (prevNetInfo && prevNetInfo[name] && prevNetTime) {
      const elapsed = (now - prevNetTime) / 1000;
      if (elapsed > 0) {
        rxSpeed = ((rxBytes - prevNetInfo[name].rxBytes) * 8) / elapsed / 1e6;
        txSpeed = ((txBytes - prevNetInfo[name].txBytes) * 8) / elapsed / 1e6;
      }
    }

    interfaces.push({
      name,
      rxBytes,
      txBytes,
      rxSpeed: Math.max(0, Math.round(rxSpeed * 100) / 100),
      txSpeed: Math.max(0, Math.round(txSpeed * 100) / 100),
    });
  }

  prevNetInfo = current;
  prevNetTime = now;

  return { interfaces };
}

async function getUptime() {
  const { content, success } = await readProcFile('/proc/uptime');
  if (!success) return 'N/A';

  const seconds = parseFloat(content.split(' ')[0]);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);

  return parts.join(' ');
}

async function collectAll() {
  const [cpu, memory, disks, network, uptime] = await Promise.all([
    getCpuUsage(),
    getMemoryUsage(),
    getDiskUsage(),
    getNetworkUsage(),
    getUptime(),
  ]);

  return { cpu, memory, disks, network, uptime };
}

module.exports = { collectAll, getCpuUsage, getMemoryUsage, getDiskUsage, getNetworkUsage, getUptime };
