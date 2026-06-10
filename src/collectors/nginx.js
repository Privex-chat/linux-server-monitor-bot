const config = require('../../config');
const fs = require('fs').promises;
const { tailLog, readLogChunk } = require('../utils/logReader');

const ATTACK_PATTERNS = [
  { pattern: /(\.\.|%2e%2e)\//i, type: 'Path Traversal' },
  { pattern: /(union\s+select|select\s+.*\s+from|insert\s+into|drop\s+table|delete\s+from)/i, type: 'SQL Injection' },
  { pattern: /(<script|javascript:|onerror=|onload=)/i, type: 'XSS' },
  { pattern: /(\/etc\/passwd|\/etc\/shadow|\/proc\/self)/i, type: 'LFI' },
  { pattern: /(wp-admin|wp-login|xmlrpc|phpmyadmin|\.env|\.git)/i, type: 'Probe/Scan' },
  {
    pattern: /(system\(|passthru\(|shell_exec\(|eval\(|[?&]cmd=[^&]*(?:wget|curl|bash|sh|nc|ncat))/i,
    type: 'RCE Attempt',
  },
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

  try {
    await fs.access(config.NGINX_ACCESS_LOG);
    result.accessAvailable = true;

    const accessOut = await tailLog(config.NGINX_ACCESS_LOG, 1000, 5000);
    if (accessOut.success && accessOut.stdout.trim()) {
      const lines = accessOut.stdout.trim().split('\n').filter(Boolean);
      const ipCounts = new Map();

      for (const line of lines) {
        const statusMatch = line.match(/"\s*(\d{3})\s/);
        if (statusMatch) {
          const code = parseInt(statusMatch[1], 10);
          if (code >= 200 && code < 300) result.statusCodes['2xx']++;
          else if (code >= 300 && code < 400) result.statusCodes['3xx']++;
          else if (code >= 400 && code < 500) result.statusCodes['4xx']++;
          else if (code >= 500) result.statusCodes['5xx']++;
        }

        const ip = extractLeadingIp(line);
        if (ip) ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);

        for (const { pattern, type } of ATTACK_PATTERNS) {
          if (pattern.test(line)) {
            result.attackAttempts.push({
              type,
              ip: ip || 'unknown',
              line: line.substring(0, 200),
            });
            break;
          }
        }
      }

      result.topIPs = [...ipCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([ip, count]) => ({ ip, count }));
    }
  } catch {
    /* access log not available */
  }

  try {
    await fs.access(config.NGINX_ERROR_LOG);
    result.errorAvailable = true;

    const errOut = await tailLog(config.NGINX_ERROR_LOG, 20, 5000);
    if (errOut.success && errOut.stdout.trim()) {
      result.recentErrors = errOut.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.substring(0, 200));
    }
  } catch {
    /* error log not available */
  }

  result.attackAttempts = result.attackAttempts.slice(-20);
  return result;
}

async function getNginxLogEntries(logType, sinceOffset = 0) {
  const logPath = logType === 'access' ? config.NGINX_ACCESS_LOG : config.NGINX_ERROR_LOG;
  const result = await readLogChunk(logPath, sinceOffset, 50000);
  if (!result.success) return { entries: [], newOffset: sinceOffset };
  return { entries: result.entries, newOffset: result.newOffset };
}

function extractLeadingIp(line) {
  const match = String(line || '').match(/^([0-9a-f:.]+)/i);
  return match ? match[1] : null;
}

module.exports = { getNginxStatus, getNginxLogEntries, ATTACK_PATTERNS };
