const { safeExec } = require('../utils/exec');
const config = require('../../config');
const fs = require('fs').promises;

const ATTACK_PATTERNS = [
  { pattern: /(\.\.|%2e%2e)/i, type: 'Path Traversal' },
  { pattern: /(union\s+select|select\s+.*\s+from|insert\s+into|drop\s+table|delete\s+from)/i, type: 'SQL Injection' },
  { pattern: /(<script|javascript:|onerror=|onload=)/i, type: 'XSS' },
  { pattern: /(\/etc\/passwd|\/etc\/shadow|\/proc\/self)/i, type: 'LFI' },
  { pattern: /(wp-admin|wp-login|xmlrpc|phpmyadmin|\.env|\.git)/i, type: 'Probe/Scan' },
  { pattern: /(cmd=|exec=|system\(|passthru|shell_exec)/i, type: 'RCE Attempt' },
];

async function getNginxStatus() {
  const result = {
    accessAvailable: false,
    errorAvailable: false,
    recentErrors: [],
    attackAttempts: [],
    statusCodes: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 },
    topIPs: [],
  };

  // ── Access Log Analysis ──
  try {
    await fs.access(config.NGINX_ACCESS_LOG);
    result.accessAvailable = true;

    // Recent status code distribution (last 1000 lines)
    const { stdout: accessOut, success: accessOk } = await safeExec(
      'bash',
      ['-c', `sudo tail -1000 ${config.NGINX_ACCESS_LOG} 2>/dev/null`],
      { timeout: 5000 }
    );

    if (accessOk && accessOut.trim()) {
      const lines = accessOut.trim().split('\n');

      for (const line of lines) {
        // Parse common log format: IP - - [date] "METHOD path HTTP/ver" STATUS size
        const statusMatch = line.match(/"\s*(\d{3})\s/);
        if (statusMatch) {
          const code = parseInt(statusMatch[1]);
          if (code >= 200 && code < 300) result.statusCodes['2xx']++;
          else if (code >= 300 && code < 400) result.statusCodes['3xx']++;
          else if (code >= 400 && code < 500) result.statusCodes['4xx']++;
          else if (code >= 500) result.statusCodes['5xx']++;
        }

        // Check for attack patterns
        for (const { pattern, type } of ATTACK_PATTERNS) {
          if (pattern.test(line)) {
            const ipMatch = line.match(/^([\d.]+)/);
            result.attackAttempts.push({
              type,
              ip: ipMatch ? ipMatch[1] : 'unknown',
              line: line.substring(0, 200),
            });
            break;
          }
        }
      }

      // Top IPs (from recent 4xx/5xx)
      const ipResult = await safeExec(
        'bash',
        ['-c', `sudo tail -1000 ${config.NGINX_ACCESS_LOG} | awk '{print $1}' | sort | uniq -c | sort -rn | head -10`],
        { timeout: 5000 }
      );

      if (ipResult.success) {
        const ipLines = ipResult.stdout.trim().split('\n').filter(Boolean);
        for (const ipLine of ipLines) {
          const match = ipLine.trim().match(/(\d+)\s+([\d.]+)/);
          if (match) {
            result.topIPs.push({ count: parseInt(match[1]), ip: match[2] });
          }
        }
      }
    }
  } catch {
    /* access log not available */
  }

  // ── Error Log ──
  try {
    await fs.access(config.NGINX_ERROR_LOG);
    result.errorAvailable = true;

    const { stdout: errOut, success: errOk } = await safeExec(
      'bash',
      ['-c', `sudo tail -20 ${config.NGINX_ERROR_LOG} 2>/dev/null`],
      { timeout: 5000 }
    );

    if (errOk && errOut.trim()) {
      result.recentErrors = errOut
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => l.substring(0, 200));
    }
  } catch {
    /* error log not available */
  }

  // Deduplicate attacks (keep last 20)
  result.attackAttempts = result.attackAttempts.slice(-20);

  return result;
}

async function getNginxLogEntries(logType, sinceOffset = 0) {
  const logPath = logType === 'access' ? config.NGINX_ACCESS_LOG : config.NGINX_ERROR_LOG;

  try {
    const stat = await fs.stat(logPath);
    if (stat.size <= sinceOffset) return { entries: [], newOffset: sinceOffset };

    const { stdout, success } = await safeExec(
      'bash',
      ['-c', `sudo tail -c +${sinceOffset + 1} ${logPath} | head -c 50000`],
      { timeout: 5000 }
    );

    if (!success) return { entries: [], newOffset: sinceOffset };

    const entries = stdout.trim().split('\n').filter(Boolean);
    return { entries, newOffset: stat.size };
  } catch {
    return { entries: [], newOffset: sinceOffset };
  }
}

module.exports = { getNginxStatus, getNginxLogEntries };
