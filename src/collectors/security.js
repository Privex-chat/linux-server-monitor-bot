const fs = require('fs').promises;
const net = require('net');
const { safeExec } = require('../utils/exec');
const logPaths = require('../utils/logPaths');
const config = require('../../config');
const { getState } = require('../utils/storage');
const { grepCount, readLogChunk, tailLog } = require('../utils/logReader');
const { summarizeEvents, ensureSecurityState, SEVERITY_RANK } = require('../utils/securityState');

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

  const state = getState();
  const securityState = ensureSecurityState(state);
  sshInfo.recentWindow = buildRecentSummary(securityState.recentSshFailures, config.SSH_FAIL_WINDOW_MS, 'ip');
  ufwInfo.recentWindow = buildRecentSummary(securityState.recentUfwBlocks, config.SSH_FAIL_WINDOW_MS, 'dstPort');
  const webAttackWindow = buildRecentSummary(securityState.recentNginxAttacks, config.SSH_FAIL_WINDOW_MS, 'type');

  const findings = buildFindings({
    sshInfo,
    fail2banInfo,
    ufwInfo,
    openPorts,
    suspiciousProcs,
    rootkitStatus,
    clamStatus,
    webAttackWindow,
  });

  const maxRank = Math.max(0, ...findings.map((finding) => SEVERITY_RANK[finding.level] || 0));
  const level = rankToLevel(maxRank);

  return {
    level,
    levelEmoji: levelToEmoji(level),
    shouldAlert: maxRank >= SEVERITY_RANK.WARNING,
    findings,
    ssh: sshInfo,
    fail2ban: fail2banInfo,
    ufw: ufwInfo,
    openPorts,
    suspiciousProcs,
    lastLogins,
    rootkit: rootkitStatus,
    clamav: clamStatus,
    webAttacks: webAttackWindow,
  };
}

function buildRecentSummary(events, windowMs, groupKey) {
  const summary = summarizeEvents(events, windowMs, Date.now(), groupKey);
  return {
    count: summary.count,
    unique: summary.unique,
    top: summary.top.map((item) => ({ [groupKey]: item.value, count: item.count })),
  };
}

function rankToLevel(rank) {
  if (rank >= SEVERITY_RANK.CRITICAL) return 'CRITICAL';
  if (rank >= SEVERITY_RANK.WARNING) return 'WARNING';
  if (rank >= SEVERITY_RANK.ADVISORY) return 'ADVISORY';
  return 'SECURE';
}

function levelToEmoji(level) {
  if (level === 'CRITICAL') return '🔴';
  if (level === 'WARNING') return '🟠';
  if (level === 'ADVISORY') return '🟡';
  return '🟢';
}

function addFinding(findings, level, key, title, detail, action = null) {
  findings.push({ level, key, title, detail, action });
}

function buildFindings({
  sshInfo,
  fail2banInfo,
  ufwInfo,
  openPorts,
  suspiciousProcs,
  rootkitStatus,
  clamStatus,
  webAttackWindow,
}) {
  const findings = [];
  const publicListeners = openPorts.ports.filter((p) => p.public);
  const publicSsh = publicListeners.some((p) => sshInfo.config.ports.includes(p.port) || p.port === 22);
  const unexpectedPublic = openPorts.unexpected.filter((p) => p.public);
  const topSshIpCount = sshInfo.recentWindow.top[0]?.count || 0;

  if (rootkitStatus.infected) {
    addFinding(findings, 'CRITICAL', 'rootkit', 'Potential rootkit detected', 'rkhunter output indicates a rootkit.');
  }

  if (clamStatus.infected > 0) {
    addFinding(
      findings,
      'CRITICAL',
      'clamav',
      'Malware detected',
      `ClamAV found ${clamStatus.infected} infected file(s).`
    );
  }

  for (const proc of suspiciousProcs.slice(0, 5)) {
    addFinding(
      findings,
      'CRITICAL',
      `process:${proc.pid}:${proc.reason}`,
      'Suspicious process detected',
      `PID ${proc.pid}: ${proc.reason} (${proc.command.substring(0, 80)})`
    );
  }

  if (!ufwInfo.available) {
    addFinding(
      findings,
      publicListeners.length ? 'WARNING' : 'ADVISORY',
      'ufw:missing',
      'UFW unavailable',
      'Firewall status could not be verified.'
    );
  } else if (ufwInfo.status !== 'active') {
    addFinding(
      findings,
      publicListeners.length ? 'CRITICAL' : 'WARNING',
      'ufw:inactive',
      'Firewall inactive',
      publicListeners.length
        ? `UFW is inactive while ${publicListeners.length} public listener(s) are exposed.`
        : 'UFW is inactive.'
    );
  }

  if (unexpectedPublic.length > 0) {
    addFinding(
      findings,
      'CRITICAL',
      `ports:unexpected:${unexpectedPublic.map((p) => p.port).join(',')}`,
      'Unexpected public listening port',
      `Unexpected public port(s): ${unexpectedPublic.map((p) => p.port).join(', ')}.`
    );
  } else if (openPorts.unexpected.length > 0) {
    addFinding(
      findings,
      'WARNING',
      `ports:local:${openPorts.unexpected.map((p) => p.port).join(',')}`,
      'Unexpected local listening port',
      `Unexpected non-public port(s): ${openPorts.unexpected.map((p) => p.port).join(', ')}.`
    );
  }

  if (publicSsh && !fail2banInfo.available) {
    addFinding(
      findings,
      'WARNING',
      'fail2ban:missing:ssh',
      'Fail2Ban unavailable for public SSH',
      'SSH is listening publicly but Fail2Ban could not be verified.'
    );
  } else if (publicSsh && fail2banInfo.available && !fail2banInfo.jails.some((j) => j.name === 'sshd')) {
    addFinding(
      findings,
      'WARNING',
      'fail2ban:sshd-missing',
      'Fail2Ban sshd jail missing',
      'Fail2Ban is running, but the sshd jail is not active.'
    );
  }

  if (
    sshInfo.recentWindow.count >= config.SSH_FAIL_WINDOW_CRIT_THRESHOLD ||
    topSshIpCount >= config.SSH_FAIL_PER_IP_CRIT_THRESHOLD
  ) {
    addFinding(
      findings,
      'CRITICAL',
      'ssh:spike',
      'SSH brute-force spike',
      `${sshInfo.recentWindow.count} failed SSH attempt(s) in the last ${Math.round(config.SSH_FAIL_WINDOW_MS / 60000)} minutes.`
    );
  } else if (
    sshInfo.recentWindow.count >= config.SSH_FAIL_WINDOW_WARN_THRESHOLD ||
    topSshIpCount >= config.SSH_FAIL_PER_IP_WARN_THRESHOLD ||
    fail2banInfo.currentlyFailed >= config.SSH_FAIL_WARN_THRESHOLD
  ) {
    addFinding(
      findings,
      'WARNING',
      'ssh:elevated',
      'Elevated SSH failures',
      `${sshInfo.recentWindow.count} recent failure(s), ${fail2banInfo.currentlyFailed} currently unbanned by Fail2Ban.`
    );
  }

  if (publicSsh && sshInfo.config.available) {
    if (sshInfo.config.passwordAuthentication !== 'no') {
      addFinding(
        findings,
        'WARNING',
        'ssh:password-auth',
        'SSH password authentication enabled',
        'Public SSH accepts passwords. Key-only SSH is safer for internet-facing servers.'
      );
    }
    if (sshInfo.config.permitRootLogin === 'yes') {
      addFinding(
        findings,
        'WARNING',
        'ssh:root-login',
        'SSH root login enabled',
        'Root login over public SSH should be disabled.'
      );
    }
  }

  if (ufwInfo.recentWindow.count >= config.UFW_BLOCK_BATCH_CRIT_THRESHOLD) {
    addFinding(
      findings,
      'CRITICAL',
      'ufw:block-spike',
      'Large firewall block spike',
      `${ufwInfo.recentWindow.count} firewall blocks in the recent window.`
    );
  } else if (ufwInfo.recentWindow.count >= config.UFW_BLOCK_BATCH_WARN_THRESHOLD) {
    addFinding(
      findings,
      'WARNING',
      'ufw:block-elevated',
      'Elevated firewall blocks',
      `${ufwInfo.recentWindow.count} firewall blocks in the recent window.`
    );
  }

  if (webAttackWindow.count >= config.NGINX_ATTACK_BATCH_CRIT_THRESHOLD) {
    addFinding(
      findings,
      'CRITICAL',
      'nginx:attack-spike',
      'Large web attack spike',
      `${webAttackWindow.count} suspicious nginx request(s) in the recent window.`
    );
  } else if (webAttackWindow.count >= config.NGINX_ATTACK_BATCH_WARN_THRESHOLD) {
    addFinding(
      findings,
      'WARNING',
      'nginx:attack-elevated',
      'Elevated web probing',
      `${webAttackWindow.count} suspicious nginx request(s) in the recent window.`
    );
  }

  if (findings.length === 0 && sshInfo.failedCount >= config.SSH_FAIL_CRIT_THRESHOLD) {
    addFinding(
      findings,
      'ADVISORY',
      'ssh:cumulative-noise',
      'Internet SSH noise observed',
      `${sshInfo.failedCount} cumulative failed SSH attempt(s) are recorded, but no active spike is present.`
    );
  }

  return findings;
}

async function getSSHInfo() {
  const result = {
    failedCount: 0,
    failedIPs: [],
    recentAttempts: [],
    available: false,
    recentWindow: { count: 0, unique: 0, top: [] },
    config: await getSshdConfig(),
  };

  const authLog = logPaths.resolve().auth;
  if (!authLog) return result;

  const countResult = await grepCount(authLog, 'Failed password', 5000);
  if (countResult.success) {
    result.available = true;
    result.failedCount = countResult.count;
  }

  const tailResult = await tailLog(authLog, 5000, 10000);
  if (tailResult.success && tailResult.stdout.trim()) {
    const failedLines = tailResult.stdout
      .split('\n')
      .filter((line) => /Failed password|Invalid user|maximum authentication attempts/i.test(line));

    result.recentAttempts = failedLines.slice(-5);

    const counts = new Map();
    for (const line of failedLines) {
      const ip = extractIp(line);
      if (ip) counts.set(ip, (counts.get(ip) || 0) + 1);
    }

    result.failedIPs = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([ip, count]) => ({ ip, count }));
  }

  return result;
}

async function getSshdConfig() {
  const result = {
    available: false,
    passwordAuthentication: 'unknown',
    permitRootLogin: 'unknown',
    pubkeyAuthentication: 'unknown',
    ports: [22],
  };

  let configResult = await safeExec('sudo', ['sshd', '-T'], { timeout: 5000 });
  if (!configResult.success) {
    configResult = await safeExec('sshd', ['-T'], { timeout: 5000 });
  }
  if (!configResult.success || !configResult.stdout.trim()) return result;

  result.available = true;
  for (const line of configResult.stdout.split('\n')) {
    const [key, value] = line.trim().split(/\s+/, 2);
    if (!key || !value) continue;
    if (key === 'passwordauthentication') result.passwordAuthentication = value;
    if (key === 'permitrootlogin') result.permitRootLogin = value;
    if (key === 'pubkeyauthentication') result.pubkeyAuthentication = value;
    if (key === 'port') result.ports = [parseInt(value, 10)].filter(Number.isInteger);
  }

  return result;
}

async function getFail2banInfo() {
  const result = { available: false, jails: [], currentlyBanned: 0, totalBanned: 0, currentlyFailed: 0 };

  const { stdout, success } = await safeExec('sudo', ['fail2ban-client', 'status'], { timeout: 5000 });
  if (!success) return result;

  result.available = true;

  const jailMatch = stdout.match(/Jail list:\s*(.*)/);
  if (!jailMatch) return result;

  const jailNames = jailMatch[1]
    .split(',')
    .map((j) => j.trim())
    .filter(Boolean);

  for (const jail of jailNames) {
    const jailResult = await safeExec('sudo', ['fail2ban-client', 'status', jail], { timeout: 5000 });
    if (!jailResult.success) continue;

    const failedMatch = jailResult.stdout.match(/Currently failed:\s*(\d+)/);
    const bannedMatch = jailResult.stdout.match(/Currently banned:\s*(\d+)/);
    const totalBannedMatch = jailResult.stdout.match(/Total banned:\s*(\d+)/);
    const bannedIpsMatch = jailResult.stdout.match(/Banned IP list:\s*(.*)/);

    const jailInfo = {
      name: jail,
      currentlyFailed: parseInt(failedMatch?.[1] || 0, 10),
      currentlyBanned: parseInt(bannedMatch?.[1] || 0, 10),
      totalBanned: parseInt(totalBannedMatch?.[1] || 0, 10),
      bannedIPs: bannedIpsMatch ? bannedIpsMatch[1].split(/\s+/).filter(Boolean) : [],
    };

    result.jails.push(jailInfo);
    result.currentlyBanned += jailInfo.currentlyBanned;
    result.totalBanned += jailInfo.totalBanned;
    result.currentlyFailed += jailInfo.currentlyFailed;
  }

  return result;
}

async function getUfwInfo() {
  const result = {
    available: false,
    status: 'unknown',
    rules: [],
    blockedCount: 0,
    recentWindow: { count: 0, unique: 0, top: [] },
  };

  const { stdout, success } = await safeExec('sudo', ['ufw', 'status', 'verbose'], { timeout: 5000 });
  if (!success) return result;

  result.available = true;
  const statusMatch = stdout.match(/Status:\s*(\w+)/);
  result.status = statusMatch ? statusMatch[1].toLowerCase() : 'unknown';

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

  const ufwLog = logPaths.resolve().ufw;
  if (ufwLog) {
    const blockResult = await grepCount(ufwLog, '[UFW BLOCK]', 5000);
    if (blockResult.success) result.blockedCount = blockResult.count;
  }

  return result;
}

async function getOpenPorts() {
  const result = { ports: [], unexpected: [] };

  const { stdout, success } = await safeExec('ss', ['-tulnp'], { timeout: 5000 });
  if (!success) return result;

  const lines = stdout.trim().split('\n').slice(1);
  for (const line of lines) {
    const parsed = parseSsLine(line);
    if (!parsed) continue;

    result.ports.push(parsed);

    if (!config.EXPECTED_PORTS.includes(parsed.port) && parsed.port < 49152) {
      result.unexpected.push(parsed);
    }
  }

  return result;
}

function parseSsLine(line) {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 5) return null;

  const netid = parts[0];
  const localIndex = parts.findIndex((part, index) => index > 0 && parseAddressPort(part));
  if (localIndex === -1) return null;

  const local = parts[localIndex];
  const parsed = parseAddressPort(local);
  if (!parsed) return null;

  const processMatch = line.match(/users:\(\("([^"]+)"/);
  return {
    protocol: netid,
    port: parsed.port,
    process: processMatch ? processMatch[1] : '',
    local,
    address: parsed.address,
    public: isPublicBindAddress(parsed.address),
  };
}

function parseAddressPort(value) {
  if (!value || value.endsWith(':*')) return null;

  const bracketMatch = value.match(/^\[(.*)]:(\d+)$/);
  if (bracketMatch) {
    return { address: bracketMatch[1], port: parseInt(bracketMatch[2], 10) };
  }

  const lastColon = value.lastIndexOf(':');
  if (lastColon === -1) return null;

  const port = parseInt(value.slice(lastColon + 1), 10);
  if (!Number.isInteger(port)) return null;

  return { address: value.slice(0, lastColon) || '*', port };
}

function isPublicBindAddress(address) {
  const normalized = String(address || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (['127.0.0.1', 'localhost', '::1'].includes(normalized)) return false;
  if (normalized.startsWith('127.')) return false;
  if (normalized.startsWith('10.')) return false;
  if (normalized.startsWith('192.168.')) return false;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)) return false;
  if (normalized.startsWith('169.254.')) return false;
  if (normalized.startsWith('fe80:')) return false;
  return ['0.0.0.0', '::', '*'].includes(normalized) || net.isIP(normalized) !== 0;
}

async function getSuspiciousProcesses() {
  const suspicious = [];

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

    if (stat.includes('Z') || command.includes('<defunct>')) continue;

    const safeCommands = [
      /^\[.*]$/,
      /^ps\b/,
      /^ss\b/,
      /^grep\b/,
      /^tail\b/,
      /^sensors\b/,
      /^df\b/,
      /^free\b/,
      /^last\b/,
      /^node\b/,
      /^npm\b/,
      /^pm2\b/,
      /^docker\b/,
    ];
    if (safeCommands.some((p) => p.test(command.trim()))) continue;

    const minerPatterns = [/xmrig/i, /minerd/i, /cpuminer/i, /stratum/i, /nicehash/i, /cryptonight/i];
    const isMiner = minerPatterns.some((p) => p.test(command));

    if (isMiner) {
      suspicious.push({ pid, user, cpu, mem, command: command.substring(0, 100), reason: 'Potential crypto miner' });
      continue;
    }

    if (cpu > 80 && !['root', 'www-data', 'mysql', 'postgres', 'redis'].includes(user)) {
      suspicious.push({ pid, user, cpu, mem, command: command.substring(0, 100), reason: 'High CPU usage' });
    }
  }

  const deletedResult = await safeExec(
    'bash',
    ['-c', "sudo ls -la /proc/*/exe 2>/dev/null | grep '(deleted)' | head -20"],
    { timeout: 5000 }
  );
  if (deletedResult.success && deletedResult.stdout.trim()) {
    const dLines = deletedResult.stdout.trim().split('\n');
    for (const dl of dLines) {
      const match = dl.match(/\/proc\/(\d+)\/exe\s+->\s+(.*?)\s+\(deleted\)/);
      if (match) {
        const pid = match[1];
        const exePath = match[2];
        const parts = dl.trim().split(/\s+/);
        const user = parts.length > 2 ? parts[2] : 'N/A';

        const safeDeleted = [
          '/usr/bin/dbus-daemon',
          '/usr/bin/python',
          '/usr/sbin/nginx',
          '/usr/bin/node',
          '/usr/local/bin/node',
          '/usr/bin/pm2',
          '/usr/libexec/',
          '/usr/lib/systemd/',
          '/lib/systemd/',
          '/usr/sbin/rsyslogd',
          '/usr/sbin/cron',
          '/usr/bin/containerd',
          '/usr/bin/dockerd',
          '/snap/',
          '/var/lib/snapd/',
        ];

        if (safeDeleted.some((p) => exePath.startsWith(p) || exePath.includes(p))) continue;

        suspicious.push({
          pid,
          user,
          cpu: 0,
          mem: 0,
          command: exePath,
          reason: 'Deleted executable running',
        });
      }
    }
  }

  return suspicious;
}

async function getLastLogins() {
  const result = { successful: [], failed: [] };

  const { stdout: lastOut, success: lastSuccess } = await safeExec('last', ['-n', '10', '-i'], { timeout: 5000 });
  if (lastSuccess) {
    result.successful = lastOut
      .trim()
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('wtmp'));
  }

  const { stdout: lastbOut, success: lastbSuccess } = await safeExec('sudo', ['lastb', '-n', '10', '-i'], {
    timeout: 5000,
  });
  if (lastbSuccess) {
    result.failed = lastbOut
      .trim()
      .split('\n')
      .filter((l) => l.trim() && !l.startsWith('btmp'));
  }

  return result;
}

async function getRootkitStatus() {
  const result = { available: false, lastScan: 'Never', infected: false, warnings: 0, summary: '' };

  try {
    const stat = await fs.stat('/var/log/rkhunter.log');
    result.lastScan = stat.mtime.toISOString();
    result.available = true;

    const tail = await tailLog('/var/log/rkhunter.log', 50, 5000);
    if (tail.success) {
      const warningMatch = tail.stdout.match(/warnings found:\s*(\d+)/i);
      if (warningMatch) result.warnings = parseInt(warningMatch[1], 10);
      
      const possibleRootkitsMatch = tail.stdout.match(/Possible rootkits:\s*(\d+)/i);
      if (possibleRootkitsMatch && parseInt(possibleRootkitsMatch[1], 10) > 0) {
        result.infected = true;
      }
      
      result.summary = tail.stdout
        .split('\n')
        .filter((l) => l.includes('Warning') || l.includes('Rootkit'))
        .slice(0, 5)
        .join('\n');
    }
  } catch {
    /* rkhunter not installed or no log */
  }

  return result;
}

async function getClamAVStatus() {
  const result = { available: false, lastScan: 'Never', infected: 0, scanned: 0, summary: '' };

  const { success } = await safeExec('which', ['clamscan'], { timeout: 3000 });
  if (!success) return result;

  result.available = true;

  try {
    const logPath = '/var/log/clamav/clamav.log';
    const stat = await fs.stat(logPath);
    result.lastScan = stat.mtime.toISOString();

    const tail = await tailLog(logPath, 20, 5000);
    if (tail.stdout) {
      const infectedMatch = tail.stdout.match(/Infected files:\s*(\d+)/);
      const scannedMatch = tail.stdout.match(/Scanned files:\s*(\d+)/);
      if (infectedMatch) result.infected = parseInt(infectedMatch[1], 10);
      if (scannedMatch) result.scanned = parseInt(scannedMatch[1], 10);
    }
  } catch {
    /* no scan log */
  }

  return result;
}

async function getAuthLogEntries(sinceOffset = 0) {
  const authLogPath = logPaths.resolve().auth;
  if (!authLogPath) return { entries: [], newOffset: sinceOffset };
  const result = await readLogChunk(authLogPath, sinceOffset, config.LOG_TAIL_MAX_BYTES);
  return { entries: result.entries, newOffset: result.newOffset };
}

function extractIp(line) {
  const match = String(line).match(/\bfrom\s+([0-9a-f:.]+)\b/i);
  if (!match) return null;
  return net.isIP(match[1]) ? match[1] : null;
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
  extractIp,
  parseSsLine,
  isPublicBindAddress,
};
