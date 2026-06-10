const net = require('net');
const { safeExec } = require('../utils/exec');
const { updateState, getState } = require('../utils/storage');
const logPaths = require('../utils/logPaths');
const { alertMention, alertAllowedMentions } = require('../utils/alert');
const config = require('../../config');
const logger = require('../utils/logger');
const { readLogChunk } = require('../utils/logReader');
const { addSecurityEvents } = require('../utils/securityState');
const { codeBlock, sendNoMentions } = require('../utils/discord');

let resources = null;
let previousPm2States = {};
let previousDockerStates = {};

function init(res) {
  resources = res;
}

async function run() {
  if (!resources) return;

  await Promise.all([
    watchAuthLog(),
    watchSyslog(),
    watchNginxLogs(),
    watchPm2Events(),
    watchDockerEvents(),
    watchUfwLog(),
  ]);
}

async function watchAuthLog() {
  const thread = resources.threads['logs-auth'];
  if (!thread) return;

  try {
    const state = getState();
    const logPath = logPaths.resolve().auth;
    if (!logPath) return;

    const read = await readLogChunk(logPath, state.logOffsets.auth || 0, config.LOG_TAIL_MAX_BYTES);
    if (!read.success || read.entries.length === 0) {
      await updateState((s) => {
        s.logOffsets.auth = read.newOffset;
      });
      return;
    }

    const botCommandPatterns = [
      /COMMAND=.*\/usr\/bin\/tail/,
      /COMMAND=.*\/usr\/bin\/grep/,
      /COMMAND=.*\/usr\/bin\/last/,
      /COMMAND=.*\/usr\/sbin\/smartctl/,
      /COMMAND=.*\/usr\/sbin\/ufw/,
      /COMMAND=.*\/usr\/bin\/fail2ban-client/,
      /COMMAND=.*\/usr\/bin\/rkhunter/,
      /COMMAND=.*\/usr\/sbin\/hddtemp/,
      /COMMAND=.*\/usr\/sbin\/nvme/,
      /COMMAND=.*ls -la \/proc/,
    ];

    const importantLines = read.entries.filter((line) => {
      if (/pam_unix\(.*:session\):\s*session (opened|closed)/i.test(line)) return false;
      if (/CRON\[/i.test(line)) return false;
      if (/\(command continued\)/i.test(line)) return false;
      if (botCommandPatterns.some((pattern) => pattern.test(line))) return false;

      if (/Failed password|Invalid user|BREAK-IN|maximum authentication attempts/i.test(line)) return true;
      if (/Accepted password|Accepted publickey/i.test(line)) return true;
      if (/sudo:/i.test(line)) return true;
      return false;
    });

    const deduped = [];
    const counts = new Map();
    const sshEvents = [];
    let failCountBatch = 0;
    const now = Date.now();

    for (const line of importantLines) {
      if (/Failed password|Invalid user|BREAK-IN|maximum authentication attempts/i.test(line)) {
        failCountBatch++;
        sshEvents.push({
          ts: now,
          ip: extractIp(line) || 'unknown',
          user: extractSshUser(line),
        });
        continue;
      }

      const msgPart = stripSyslogPrefix(line);
      if (counts.has(msgPart)) {
        counts.set(msgPart, counts.get(msgPart) + 1);
      } else {
        counts.set(msgPart, 1);
        deduped.push(line);
      }
    }

    await updateState((s) => {
      if (failCountBatch > 0) {
        s.dailyAccumulator.sshFailures = (s.dailyAccumulator.sshFailures || 0) + failCountBatch;
        addSecurityEvents(s, 'recentSshFailures', sshEvents, now);
      }
      s.logOffsets.auth = read.newOffset;
    });

    const output = deduped.map((line) => {
      const msgPart = stripSyslogPrefix(line);
      const count = counts.get(msgPart);
      const prefix = /Accepted password|Accepted publickey/i.test(line) ? '🟢' : /sudo:/i.test(line) ? '🟡' : '⚪';
      return count > 1 ? `${prefix} ${line} [x${count}]` : `${prefix} ${line}`;
    });

    for (let i = 0; i < output.length; i += 10) {
      const chunk = output.slice(i, i + 10);
      await sendNoMentions(thread, codeBlock(chunk.join('\n'), 1900));
    }
  } catch (err) {
    logger.error(`Auth log watch error: ${err.message}`);
  }
}

async function watchSyslog() {
  const thread = resources.threads['logs-system'];
  if (!thread) return;

  try {
    const state = getState();
    const logPath = logPaths.resolve().syslog;
    if (!logPath) return;

    const read = await readLogChunk(logPath, state.logOffsets.syslog || 0, config.LOG_TAIL_MAX_BYTES);
    if (!read.success || read.entries.length === 0) {
      await updateState((s) => {
        s.logOffsets.syslog = read.newOffset;
      });
      return;
    }

    const noisyServices = [
      /cloudflared\[/,
      /snapd\[/,
      /systemd-resolved\[/,
      /networkd-dispatcher\[/,
      /tailscaled\[/,
      /NetworkManager\[/,
    ];

    const important = read.entries.filter((line) => {
      if (!/error|fail|critical|panic|oom|killed|segfault|out of memory/i.test(line)) return false;
      return !noisyServices.some((pattern) => pattern.test(line));
    });

    const deduped = [];
    const counts = new Map();
    for (const line of important) {
      const msgPart = stripSyslogPrefix(line)
        .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, '')
        .replace(/\d{10,}/g, '')
        .trim();

      if (counts.has(msgPart)) {
        counts.set(msgPart, counts.get(msgPart) + 1);
      } else {
        counts.set(msgPart, 1);
        deduped.push({ line, msgPart });
      }
    }

    const output = deduped.map(({ line, msgPart }) => {
      const count = counts.get(msgPart);
      return count > 1 ? `${line} [x${count}]` : line;
    });

    for (let i = 0; i < output.length; i += 10) {
      const chunk = output.slice(i, i + 10);
      await sendNoMentions(thread, codeBlock(chunk.join('\n'), 1900));
    }

    await updateState((s) => {
      s.logOffsets.syslog = read.newOffset;
    });
  } catch (err) {
    logger.error(`Syslog watch error: ${err.message}`);
  }
}

async function watchNginxLogs() {
  const thread = resources.threads['logs-nginx'];
  if (!thread) return;

  try {
    const state = getState();

    const errorRead = await readLogChunk(config.NGINX_ERROR_LOG, state.logOffsets.nginx_error || 0, 30000);
    if (errorRead.success) {
      const errorLines = errorRead.entries.filter((line) => /error|crit|alert|emerg/i.test(line));
      for (let i = 0; i < errorLines.length; i += 10) {
        const chunk = errorLines.slice(i, i + 10);
        await sendNoMentions(thread, `🔴 **nginx errors:**\n${codeBlock(chunk.join('\n'), 1800)}`);
      }
      await updateState((s) => {
        s.logOffsets.nginx_error = errorRead.newOffset;
      });
    }

    const accessRead = await readLogChunk(config.NGINX_ACCESS_LOG, state.logOffsets.nginx_access || 0, 50000);
    if (!accessRead.success) return;

    const attackPatterns = [
      { type: 'Path Traversal', pattern: /(\.\.|%2e%2e)\//i },
      { type: 'SQL Injection', pattern: /(union\s+select|drop\s+table|insert\s+into)/i },
      { type: 'XSS', pattern: /(<script|javascript:|onerror=)/i },
      { type: 'LFI', pattern: /(\/etc\/passwd|\/proc\/self)/i },
      { type: 'RCE', pattern: /(system\(|shell_exec\(|[?&]cmd=[^&]*(?:wget|curl|bash|sh|nc|ncat))/i },
      { type: 'Probe', pattern: /(wp-admin|wp-login|xmlrpc|phpmyadmin|\.env|\.git)/i },
    ];

    const now = Date.now();
    const attacks = [];
    for (const line of accessRead.entries) {
      const hit = attackPatterns.find(({ pattern }) => pattern.test(line));
      if (!hit) continue;
      attacks.push({
        ts: now,
        type: hit.type,
        ip: extractLeadingIp(line) || 'unknown',
        sample: line.substring(0, 180),
      });
    }

    await updateState((s) => {
      if (attacks.length > 0) {
        s.dailyAccumulator.nginxAttacks = (s.dailyAccumulator.nginxAttacks || 0) + attacks.length;
        addSecurityEvents(s, 'recentNginxAttacks', attacks, now);
      }
      s.logOffsets.nginx_access = accessRead.newOffset;
    });

    if (attacks.length >= config.NGINX_ATTACK_BATCH_WARN_THRESHOLD) {
      const byType = countBy(attacks, 'type');
      const byIp = countBy(attacks, 'ip');
      const content = [
        `🛡️ **${attacks.length} suspicious nginx requests in this batch**`,
        `Types: ${formatTopCounts(byType)}`,
        `Top IPs: ${formatTopCounts(byIp)}`,
        codeBlock(
          attacks
            .slice(0, 5)
            .map((attack) => attack.sample)
            .join('\n'),
          1500
        ),
      ].join('\n');
      await sendNoMentions(thread, content.substring(0, 1900));
    }
  } catch (err) {
    logger.error(`Nginx log watch error: ${err.message}`);
  }
}

async function watchPm2Events() {
  const thread = resources.threads['logs-pm2'];
  if (!thread) return;

  try {
    const { stdout, success } = await safeExec('pm2', ['jlist'], { timeout: 10000 });
    if (!success) return;

    const processes = JSON.parse(stdout);
    const currentStates = {};

    for (const proc of processes) {
      const key = `${proc.pm_id}_${proc.name}`;
      const status = proc.pm2_env?.status || 'unknown';
      currentStates[key] = {
        status,
        restarts: proc.pm2_env?.restart_time || 0,
        name: proc.name,
        id: proc.pm_id,
      };

      const prev = previousPm2States[key];
      if (!prev) continue;

      if (prev.status !== status) {
        const icon = status === 'online' ? '🟢' : status === 'errored' ? '🔴' : '🟡';
        let msg = `${icon} **PM2 [${proc.name}]** status changed: \`${prev.status}\` -> \`${status}\``;

        if (status === 'errored' || status === 'stopped') {
          msg += `\n${alertMention()}`;
          await thread.send({ content: msg, allowedMentions: alertAllowedMentions() });
        } else {
          await sendNoMentions(thread, msg);
        }
      }

      if (currentStates[key].restarts > prev.restarts) {
        const diff = currentStates[key].restarts - prev.restarts;
        await sendNoMentions(
          thread,
          `🔄 **PM2 [${proc.name}]** restarted ${diff} time(s). Total restarts: ${currentStates[key].restarts}`
        );
      }
    }

    previousPm2States = currentStates;
  } catch (err) {
    logger.error(`PM2 event watch error: ${err.message}`);
  }
}

async function watchDockerEvents() {
  const thread = resources.threads['logs-docker'];
  if (!thread) return;

  try {
    const { stdout, success } = await safeExec('docker', ['ps', '-a', '--format', '{{json .}}'], { timeout: 10000 });
    if (!success) return;

    const lines = stdout.trim().split('\n').filter(Boolean);
    const currentStates = {};

    for (const line of lines) {
      try {
        const c = JSON.parse(line);
        currentStates[c.ID] = {
          name: c.Names,
          state: c.State,
          status: c.Status,
          image: c.Image,
        };

        const prev = previousDockerStates[c.ID];
        if (prev && prev.state !== c.State) {
          const icon = c.State === 'running' ? '🟢' : c.State === 'exited' ? '🔴' : '🟡';
          let msg = `${icon} **Docker [${c.Names}]** state changed: \`${prev.state}\` -> \`${c.State}\``;
          msg += `\n   Image: \`${c.Image}\` | Status: \`${c.Status}\``;

          if (c.State === 'exited' || c.State === 'dead') {
            msg += `\n${alertMention()}`;
            await thread.send({ content: msg, allowedMentions: alertAllowedMentions() });
          } else {
            await sendNoMentions(thread, msg);
          }
        }
      } catch {
        /* skip malformed docker line */
      }
    }

    previousDockerStates = currentStates;
  } catch (err) {
    logger.error(`Docker event watch error: ${err.message}`);
  }
}

async function watchUfwLog() {
  const thread = resources.threads['logs-security'];
  if (!thread) return;

  try {
    const logPath = logPaths.resolve().ufw;
    if (!logPath) return;

    const state = getState();
    const read = await readLogChunk(logPath, state.logOffsets.ufw || 0, 30000);
    if (!read.success || read.entries.length === 0) {
      await updateState((s) => {
        s.logOffsets.ufw = read.newOffset;
      });
      return;
    }

    const lanNoisePatterns = [
      /DST=224\./,
      /DST=255\.255\.255\.255/,
      /PROTO=2\b/,
      /PROTO=ICMPv6 TYPE=13[35]/,
      /PROTO=ICMPv6 TYPE=134/,
      /DPT=7\b/,
      /SRC=fe80:/i,
    ];

    const blocks = read.entries
      .filter((line) => /\[UFW BLOCK]/i.test(line))
      .filter((line) => !lanNoisePatterns.some((pattern) => pattern.test(line)));

    const now = Date.now();
    const events = blocks.map((line) => ({
      ts: now,
      src: parseUfwField(line, 'SRC') || 'unknown',
      dstPort: parseUfwField(line, 'DPT') || 'unknown',
      proto: parseUfwField(line, 'PROTO') || 'unknown',
      sample: line.substring(0, 220),
    }));

    await updateState((s) => {
      if (events.length > 0) {
        s.dailyAccumulator.ufwBlocks = (s.dailyAccumulator.ufwBlocks || 0) + events.length;
        addSecurityEvents(s, 'recentUfwBlocks', events, now);
      }
      s.logOffsets.ufw = read.newOffset;
    });

    if (events.length >= config.UFW_BLOCK_BATCH_WARN_THRESHOLD) {
      const byPort = countBy(events, 'dstPort');
      const bySrc = countBy(events, 'src');
      const content = [
        `🔥 **UFW block spike:** ${events.length} blocked connections in this batch`,
        `Top ports: ${formatTopCounts(byPort)}`,
        `Top sources: ${formatTopCounts(bySrc)}`,
        codeBlock(
          events
            .slice(-5)
            .map((event) => event.sample)
            .join('\n'),
          1500
        ),
      ].join('\n');
      await sendNoMentions(thread, content.substring(0, 1900));
    }
  } catch (err) {
    logger.error(`UFW log watch error: ${err.message}`);
  }
}

function stripSyslogPrefix(line) {
  return String(line || '')
    .replace(/^\S+\s+\S+\s+\S+\s+/, '')
    .trim();
}

function extractIp(line) {
  const match = String(line || '').match(/\bfrom\s+([0-9a-f:.]+)\b/i);
  if (!match) return null;
  return net.isIP(match[1]) ? match[1] : null;
}

function extractLeadingIp(line) {
  const match = String(line || '').match(/^([0-9a-f:.]+)/i);
  if (!match) return null;
  return net.isIP(match[1]) ? match[1] : null;
}

function extractSshUser(line) {
  const text = String(line || '');
  const invalid = text.match(/Invalid user\s+([^\s]+)/i);
  if (invalid) return invalid[1].substring(0, 80);
  const failed = text.match(/Failed password for (?:invalid user )?([^\s]+)/i);
  return failed ? failed[1].substring(0, 80) : 'unknown';
}

function parseUfwField(line, field) {
  const match = String(line || '').match(new RegExp(`\\b${field}=([^\\s]+)`));
  return match ? match[1] : null;
}

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) {
    const value = item[key] || 'unknown';
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}

function formatTopCounts(counts, limit = 5) {
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => `${value} (${count})`);
  return top.length > 0 ? top.join(', ') : 'none';
}

module.exports = { init, run };
