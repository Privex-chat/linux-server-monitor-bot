const { safeExec, readProcFile } = require('../utils/exec');
const config = require('../../config');
const logger = require('../utils/logger');
const fs = require('fs').promises;

async function getSecurityStatus() {
  const [sshInfo, fail2banInfo, ufwInfo, openPorts, suspiciousProcs, lastLogins, rootkitStatus, clamStatus] =
    await Promise.all([
      getSSHInfo(),
      getFail2banInfo(),
      getUfwInfo(),
      getOpenPorts(),
      getSuspiciousProcesses(),
      getLastLogins(),
      getRootkitStatus(),
      getClamAVStatus(),
    ]);

  // Determine overall threat level
  let level = 'SECURE';
  let levelEmoji = '🟢';

  const scores = [];
  if (sshInfo.failedCount >= config.SSH_FAIL_CRIT_THRESHOLD) scores.push(3);
  else if (sshInfo.failedCount >= config.SSH_FAIL_WARN_THRESHOLD) scores.push(2);

  if (fail2banInfo.totalBanned > 20) scores.push(2);
  if (suspiciousProcs.length > 0) scores.push(3);
  if (rootkitStatus.infected) scores.push(3);
  if (clamStatus.infected > 0) scores.push(3);

  const maxScore = Math.max(0, ...scores);
  if (maxScore >= 3) {
    level = 'CRITICAL';
    levelEmoji = '🔴';
  } else if (maxScore >= 2) {
    level = 'WARNING';
    levelEmoji = '🟠';
  } else if (maxScore >= 1) {
    level = 'ADVISORY';
    levelEmoji = '🟡';
  }

  return {
    level,
    levelEmoji,
    shouldAlert: maxScore >= 2,
    ssh: sshInfo,
    fail2ban: fail2banInfo,
    ufw: ufwInfo,
    openPorts,
    suspiciousProcs,
    lastLogins,
    rootkit: rootkitStatus,
    clamav: clamStatus,
  };
}

async function getSSHInfo() {
  const result = { failedCount: 0, failedIPs: [], recentAttempts: [], available: false };

  // Count failed attempts in last 24h from auth.log
  const { stdout, success } = await safeExec('sudo', [
    'grep',
    '-c',
    'Failed password',
    '/var/log/auth.log',
  ], { timeout: 5000 });

  if (success) {
    result.available = true;
    result.failedCount = parseInt(stdout.trim()) || 0;
  }

  // Get unique IPs with failed attempts
  const ipResult = await safeExec('bash', [
    '-c',
    "sudo grep 'Failed password' /var/log/auth.log | grep -oP '\\d+\\.\\d+\\.\\d+\\.\\d+' | sort | uniq -c | sort -rn | head -10",
  ], { timeout: 5000 });

  if (ipResult.success) {
    const lines = ipResult.stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const match = line.trim().match(/(\d+)\s+([\d.]+)/);
      if (match) {
        result.failedIPs.push({ count: parseInt(match[1]), ip: match[2] });
      }
    }
  }

  // Recent failed attempts (last 5)
  const recentResult = await safeExec('bash', [
    '-c',
    "sudo grep 'Failed password' /var/log/auth.log | tail -5",
  ], { timeout: 5000 });

  if (recentResult.success) {
    result.recentAttempts = recentResult.stdout.trim().split('\n').filter(Boolean);
  }

  return result;
}

async function getFail2banInfo() {
  const result = { available: false, jails: [], totalBanned: 0, totalFailed: 0 };

  const { stdout, success } = await safeExec('sudo', ['fail2ban-client', 'status'], { timeout: 5000 });
  if (!success) return result;

  result.available = true;

  const jailMatch = stdout.match(/Jail list:\s*(.*)/);
  if (!jailMatch) return result;

  const jailNames = jailMatch[1].split(',').map((j) => j.trim()).filter(Boolean);

  for (const jail of jailNames) {
    const jailResult = await safeExec('sudo', ['fail2ban-client', 'status', jail], { timeout: 5000 });
    if (!jailResult.success) continue;

    const failedMatch = jailResult.stdout.match(/Currently failed:\s*(\d+)/);
    const bannedMatch = jailResult.stdout.match(/Currently banned:\s*(\d+)/);
    const totalBannedMatch = jailResult.stdout.match(/Total banned:\s*(\d+)/);

    const jailInfo = {
      name: jail,
      currentlyFailed: parseInt(failedMatch?.[1] || 0),
      currentlyBanned: parseInt(bannedMatch?.[1] || 0),
      totalBanned: parseInt(totalBannedMatch?.[1] || 0),
    };

    result.jails.push(jailInfo);
    result.totalBanned += jailInfo.currentlyBanned;
    result.totalFailed += jailInfo.currentlyFailed;
  }

  return result;
}

async function getUfwInfo() {
  const result = { available: false, status: 'unknown', rules: [], blockedCount: 0 };

  const { stdout, success } = await safeExec('sudo', ['ufw', 'status', 'verbose'], { timeout: 5000 });
  if (!success) return result;

  result.available = true;
  const statusMatch = stdout.match(/Status:\s*(\w+)/);
  result.status = statusMatch ? statusMatch[1] : 'unknown';

  const lines = stdout.split('\n');
  let inRules = false;
  for (const line of lines) {
    if (line.match(/^---/)) {
      inRules = true;
      continue;
    }
    if (inRules && line.trim()) {
      result.rules.push(line.trim());
    }
  }

  // Count blocked connections from UFW log
  const blockResult = await safeExec('bash', [
    '-c',
    "sudo grep -c '\\[UFW BLOCK\\]' /var/log/ufw.log 2>/dev/null || echo 0",
  ], { timeout: 5000 });
  if (blockResult.success) {
    result.blockedCount = parseInt(blockResult.stdout.trim()) || 0;
  }

  return result;
}

async function getOpenPorts() {
  const result = { ports: [], unexpected: [] };

  const { stdout, success } = await safeExec('ss', ['-tlnp'], { timeout: 5000 });
  if (!success) return result;

  const lines = stdout.trim().split('\n').slice(1);
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const localAddr = parts[3] || '';
    const portMatch = localAddr.match(/:(\d+)$/);
    if (!portMatch) continue;

    const port = parseInt(portMatch[1]);
    const process = parts[5] || '';

    result.ports.push({ port, process, local: localAddr });

    if (!config.EXPECTED_PORTS.includes(port) && port < 49152) {
      result.unexpected.push({ port, process, local: localAddr });
    }
  }

  return result;
}

async function getSuspiciousProcesses() {
  const suspicious = [];

  // High CPU processes (>80% for non-system)
  const { stdout, success } = await safeExec('ps', ['aux', '--sort=-%cpu'], { timeout: 5000 });
  if (!success) return suspicious;

  const lines = stdout.trim().split('\n').slice(1, 20);
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const user = parts[0];
    const pid = parts[1];
    const cpu = parseFloat(parts[2]);
    const mem = parseFloat(parts[3]);
    const stat = parts[7] || '';
    const command = parts.slice(10).join(' ');

    // Skip zombie/defunct processes (harmless, often caused by monitoring tools)
    if (stat.includes('Z') || command.includes('<defunct>')) continue;

    // Skip known system utilities (the bot itself spawns these)
    const safeCommands = [/^\[.*\]$/, /^ps\b/, /^ss\b/, /^grep\b/, /^tail\b/, /^sensors\b/, /^df\b/, /^free\b/, /^last\b/, /^node\b/, /^npm\b/, /^pm2\b/, /^docker\b/];
    if (safeCommands.some((p) => p.test(command.trim()))) continue;

    // Flag crypto miner patterns
    const minerPatterns = [/xmrig/i, /minerd/i, /cpuminer/i, /stratum/i, /nicehash/i, /cryptonight/i];
    const isMiner = minerPatterns.some((p) => p.test(command));

    if (isMiner) {
      suspicious.push({ pid, user, cpu, mem, command: command.substring(0, 100), reason: 'Potential crypto miner' });
      continue;
    }

    // Unusually high CPU from non-root, non-system users
    if (cpu > 80 && !['root', 'www-data', 'mysql', 'postgres', 'redis'].includes(user)) {
      suspicious.push({ pid, user, cpu, mem, command: command.substring(0, 100), reason: 'High CPU usage' });
    }
  }

  // Check for deleted executables (common malware indicator)
  const deletedResult = await safeExec('bash', [
    '-c',
    "sudo ls -la /proc/*/exe 2>/dev/null | grep '(deleted)' | head -5",
  ], { timeout: 5000 });
  if (deletedResult.success && deletedResult.stdout.trim()) {
    const dLines = deletedResult.stdout.trim().split('\n');
    for (const dl of dLines) {
      suspicious.push({ pid: 'N/A', user: 'N/A', cpu: 0, mem: 0, command: dl.trim().substring(0, 100), reason: 'Deleted executable running' });
    }
  }

  return suspicious;
}

async function getLastLogins() {
  const result = { successful: [], failed: [] };

  const { stdout: lastOut, success: lastSuccess } = await safeExec('last', ['-n', '10', '-i'], { timeout: 5000 });
  if (lastSuccess) {
    result.successful = lastOut.trim().split('\n').filter((l) => l.trim() && !l.startsWith('wtmp'));
  }

  const { stdout: lastbOut, success: lastbSuccess } = await safeExec('sudo', ['lastb', '-n', '10', '-i'], { timeout: 5000 });
  if (lastbSuccess) {
    result.failed = lastbOut.trim().split('\n').filter((l) => l.trim() && !l.startsWith('btmp'));
  }

  return result;
}

async function getRootkitStatus() {
  const result = { available: false, lastScan: 'Never', infected: false, warnings: 0, summary: '' };

  // Check rkhunter log
  try {
    const stat = await fs.stat('/var/log/rkhunter.log');
    result.lastScan = stat.mtime.toISOString();
    result.available = true;

    const { stdout, success } = await safeExec('sudo', [
      'tail',
      '-50',
      '/var/log/rkhunter.log',
    ], { timeout: 5000 });

    if (success) {
      const warningMatch = stdout.match(/warnings found:\s*(\d+)/i);
      if (warningMatch) result.warnings = parseInt(warningMatch[1]);
      if (stdout.toLowerCase().includes('rootkit') && stdout.toLowerCase().includes('found')) {
        result.infected = true;
      }
      result.summary = stdout.split('\n').filter((l) => l.includes('Warning') || l.includes('Rootkit')).slice(0, 5).join('\n');
    }
  } catch {
    /* rkhunter not installed or no log */
  }

  return result;
}

async function getClamAVStatus() {
  const result = { available: false, lastScan: 'Never', infected: 0, scanned: 0, summary: '' };

  // Check if ClamAV is installed
  const { success } = await safeExec('which', ['clamscan'], { timeout: 3000 });
  if (!success) return result;

  result.available = true;

  // Check for recent scan logs
  try {
    const logPath = '/var/log/clamav/clamav.log';
    const stat = await fs.stat(logPath);
    result.lastScan = stat.mtime.toISOString();

    const { stdout } = await safeExec('sudo', ['tail', '-20', logPath], { timeout: 5000 });
    if (stdout) {
      const infectedMatch = stdout.match(/Infected files:\s*(\d+)/);
      const scannedMatch = stdout.match(/Scanned files:\s*(\d+)/);
      if (infectedMatch) result.infected = parseInt(infectedMatch[1]);
      if (scannedMatch) result.scanned = parseInt(scannedMatch[1]);
    }
  } catch {
    /* no scan log */
  }

  return result;
}

// Get new auth log entries since a given offset
async function getAuthLogEntries(sinceOffset = 0) {
  try {
    const stat = await fs.stat('/var/log/auth.log');
    if (stat.size <= sinceOffset) return { entries: [], newOffset: sinceOffset };

    const { stdout, success } = await safeExec('bash', [
      '-c',
      `sudo tail -c +${sinceOffset + 1} /var/log/auth.log | head -c 50000`,
    ], { timeout: 5000 });

    if (!success) return { entries: [], newOffset: sinceOffset };

    const entries = stdout.trim().split('\n').filter(Boolean);
    return { entries, newOffset: stat.size };
  } catch {
    return { entries: [], newOffset: sinceOffset };
  }
}

module.exports = {
  getSecurityStatus,
  getSSHInfo,
  getFail2banInfo,
  getUfwInfo,
  getOpenPorts,
  getSuspiciousProcesses,
  getLastLogins,
  getRootkitStatus,
  getClamAVStatus,
  getAuthLogEntries,
};
