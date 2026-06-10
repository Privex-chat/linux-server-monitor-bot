const fs = require('fs').promises;
const { safeExec } = require('../utils/exec');
const { updateState, getState } = require('../utils/storage');
const logPaths = require('../utils/logPaths');
const { alertMention } = require('../utils/alert');
const config = require('../../config');
const logger = require('../utils/logger');

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

// ── Auth Log ─────────────────────────────────────────────

async function watchAuthLog() {
  const thread = resources.threads['logs-auth'];
  if (!thread) return;

  try {
    const state = getState();
    const logPath = logPaths.resolve().auth;
    if (!logPath) return; // Log file not found on this distro

    let fileSize;
    try {
      const stat = await fs.stat(logPath);
      fileSize = stat.size;
    } catch {
      return; // File doesn't exist
    }

    const offset = state.logOffsets.auth || 0;
    if (fileSize <= offset) return;

    // Handle log rotation (file size smaller than offset)
    const effectiveOffset = fileSize < offset ? 0 : offset;

    const { stdout, success } = await safeExec(
      'bash',
      ['-c', `sudo tail -c +${effectiveOffset + 1} ${logPath} | head -c 50000`],
      { timeout: 5000 }
    );

    if (!success || !stdout.trim()) {
      await updateState((s) => {
        s.logOffsets.auth = fileSize;
      });
      return;
    }

    const lines = stdout.trim().split('\n');

    // Bot's own monitoring commands to ignore
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

    const importantLines = lines.filter((l) => {
      // Skip ALL session opened/closed lines (noise from every sudo/ssh/cron)
      if (/pam_unix\(.*:session\):\s*session (opened|closed)/i.test(l)) return false;
      // Skip CRON entirely
      if (/CRON\[/i.test(l)) return false;
      // Skip sudo wrapped lines
      if (/\(command continued\)/i.test(l)) return false;
      // Skip bot's own sudo monitoring commands
      if (botCommandPatterns.some((p) => p.test(l))) return false;

      // Only keep genuinely important events
      if (/Failed password|Invalid user|BREAK-IN/i.test(l)) return true;
      if (/Accepted password|Accepted publickey/i.test(l)) return true;
      if (/sudo:/i.test(l)) return true; // non-bot sudo commands
      return false;
    });

    if (importantLines.length > 0) {
      // Deduplicate repeated entries
      const deduped = [];
      const counts = new Map();
      let failCountBatch = 0;

      for (const line of importantLines) {
        if (/Failed password|Invalid user|BREAK-IN/i.test(line)) {
          failCountBatch++;
          continue; // Don't print failures to thread, they are too noisy
        }

        const msgPart = line.replace(/^\S+\s+\S+\s+\S+\s+/, '').trim();
        if (counts.has(msgPart)) {
          counts.set(msgPart, counts.get(msgPart) + 1);
        } else {
          counts.set(msgPart, 1);
          deduped.push(line);
        }
      }

      // Add to daily accumulator instead of alerting
      if (failCountBatch > 0) {
        await updateState((s) => {
          if (s.dailyAccumulator.sshFailures === undefined) {
            s.dailyAccumulator.sshFailures = 0;
          }
          s.dailyAccumulator.sshFailures += failCountBatch;
        });
      }

      const output = deduped.map((line) => {
        const msgPart = line.replace(/^\S+\s+\S+\s+\S+\s+/, '').trim();
        const count = counts.get(msgPart);
        const prefix = /Accepted password|Accepted publickey/i.test(line)
            ? '🟢'
            : /sudo:/i.test(line)
              ? '🟡'
              : '⚪';
        return count > 1 ? `${prefix} ${line} [×${count}]` : `${prefix} ${line}`;
      });

      if (output.length > 0) {
        for (let i = 0; i < output.length; i += 10) {
          const chunk = output.slice(i, i + 10);
          await thread.send(`\`\`\`\n${chunk.join('\n').substring(0, 1900)}\n\`\`\``);
        }
      }
    }

    await updateState((s) => {
      s.logOffsets.auth = fileSize;
    });
  } catch (err) {
    logger.error(`Auth log watch error: ${err.message}`);
  }
}

// ── Syslog ───────────────────────────────────────────────

async function watchSyslog() {
  const thread = resources.threads['logs-system'];
  if (!thread) return;

  try {
    const state = getState();
    const logPath = logPaths.resolve().syslog;
    if (!logPath) return; // Log file not found on this distro

    let fileSize;
    try {
      const stat = await fs.stat(logPath);
      fileSize = stat.size;
    } catch {
      return;
    }

    const offset = state.logOffsets.syslog || 0;
    if (fileSize <= offset) return;

    const effectiveOffset = fileSize < offset ? 0 : offset;

    const { stdout, success } = await safeExec(
      'bash',
      ['-c', `sudo tail -c +${effectiveOffset + 1} ${logPath} | head -c 50000`],
      { timeout: 5000 }
    );

    if (!success || !stdout.trim()) {
      await updateState((s) => {
        s.logOffsets.syslog = fileSize;
      });
      return;
    }

    const lines = stdout.trim().split('\n');

    // Skip known noisy/spammy services
    const noisyServices = [
      /cloudflared\[/, // Broken tunnel retries
      /snapd\[/, // Snap auto-updates
      /systemd-resolved\[/, // DNS resolver chatter
      /networkd-dispatcher\[/, // Network state changes
    ];

    // Only surface errors, warnings, critical events (excluding noise)
    const important = lines.filter((l) => {
      if (!/error|fail|critical|panic|oom|killed|segfault|out of memory/i.test(l)) return false;
      if (noisyServices.some((p) => p.test(l))) return false;
      return true;
    });

    if (important.length > 0) {
      // Deduplicate: collapse repeated identical messages
      const deduped = [];
      const counts = new Map();
      for (const line of important) {
        // Strip syslog timestamp AND any embedded ISO/epoch timestamps for comparison
        const msgPart = line
          .replace(/^\S+\s+\S+\s+\S+\s+/, '') // syslog timestamp + hostname
          .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, '') // embedded ISO timestamps
          .replace(/\d{10,}/g, '') // epoch timestamps
          .trim();
        if (counts.has(msgPart)) {
          counts.set(msgPart, counts.get(msgPart) + 1);
        } else {
          counts.set(msgPart, 1);
          deduped.push({ line, msgPart });
        }
      }

      // Append repeat counts
      const output = deduped.map(({ line, msgPart }) => {
        const count = counts.get(msgPart);
        return count > 1 ? `${line} [×${count}]` : line;
      });

      for (let i = 0; i < output.length; i += 10) {
        const chunk = output.slice(i, i + 10);
        await thread.send(`\`\`\`\n${chunk.join('\n').substring(0, 1900)}\n\`\`\``);
      }
    }

    await updateState((s) => {
      s.logOffsets.syslog = fileSize;
    });
  } catch (err) {
    logger.error(`Syslog watch error: ${err.message}`);
  }
}

// ── Nginx Logs ───────────────────────────────────────────

async function watchNginxLogs() {
  const thread = resources.threads['logs-nginx'];
  if (!thread) return;

  try {
    const state = getState();

    // Error log
    try {
      const stat = await fs.stat(config.NGINX_ERROR_LOG);
      const offset = state.logOffsets.nginx_error || 0;

      if (stat.size > offset) {
        const effectiveOffset = stat.size < offset ? 0 : offset;
        const { stdout, success } = await safeExec(
          'bash',
          ['-c', `sudo tail -c +${effectiveOffset + 1} ${config.NGINX_ERROR_LOG} | head -c 30000`],
          { timeout: 5000 }
        );

        if (success && stdout.trim()) {
          const lines = stdout.trim().split('\n').filter(Boolean);
          if (lines.length > 0) {
            const errorLines = lines.filter((l) => /error|crit|alert|emerg/i.test(l));
            if (errorLines.length > 0) {
              for (let i = 0; i < errorLines.length; i += 10) {
                const chunk = errorLines.slice(i, i + 10);
                await thread.send(`🔴 **nginx errors:**\n\`\`\`\n${chunk.join('\n').substring(0, 1800)}\n\`\`\``);
              }
            }
          }
        }
        await updateState((s) => {
          s.logOffsets.nginx_error = stat.size;
        });
      }
    } catch {
      /* file doesn't exist */
    }

    // Access log — only flag attack patterns
    try {
      const stat = await fs.stat(config.NGINX_ACCESS_LOG);
      const offset = state.logOffsets.nginx_access || 0;

      if (stat.size > offset) {
        const effectiveOffset = stat.size < offset ? 0 : offset;
        const { stdout, success } = await safeExec(
          'bash',
          ['-c', `sudo tail -c +${effectiveOffset + 1} ${config.NGINX_ACCESS_LOG} | head -c 50000`],
          { timeout: 5000 }
        );

        if (success && stdout.trim()) {
          const attackPatterns = [
            /(\.\.|%2e%2e)\//i,
            /(union\s+select|drop\s+table|insert\s+into)/i,
            /(<script|javascript:|onerror=)/i,
            /(\/etc\/passwd|\/proc\/self)/i,
            /(system\(|shell_exec\(|[?&]cmd=[^&]*(?:wget|curl|bash|sh|nc|ncat))/i,
          ];

          const lines = stdout.trim().split('\n');
          const attacks = lines.filter((l) => attackPatterns.some((p) => p.test(l)));

          if (attacks.length > 0) {
            const truncated = attacks.slice(0, 10).map((l) => l.substring(0, 150));
            await thread.send(
              `🛡️ **${attacks.length} suspicious nginx requests detected:**\n${alertMention()}\n\`\`\`\n${truncated.join('\n')}\n\`\`\``
            );
          }
        }
        await updateState((s) => {
          s.logOffsets.nginx_access = stat.size;
        });
      }
    } catch {
      /* file doesn't exist */
    }
  } catch (err) {
    logger.error(`Nginx log watch error: ${err.message}`);
  }
}

// ── PM2 Events ───────────────────────────────────────────

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
      if (prev) {
        // Status change
        if (prev.status !== status) {
          const icon = status === 'online' ? '🟢' : status === 'errored' ? '🔴' : '🟡';
          let msg = `${icon} **PM2 [${proc.name}]** status changed: \`${prev.status}\` → \`${status}\``;

          if (status === 'errored' || status === 'stopped') {
            msg += `\n${alertMention()}`;
          }

          await thread.send(msg);
        }

        // Restart detected
        if (currentStates[key].restarts > prev.restarts) {
          const diff = currentStates[key].restarts - prev.restarts;
          await thread.send(
            `🔄 **PM2 [${proc.name}]** restarted ${diff} time(s). Total restarts: ${currentStates[key].restarts}`
          );
        }
      }
    }

    previousPm2States = currentStates;
  } catch (err) {
    logger.error(`PM2 event watch error: ${err.message}`);
  }
}

// ── Docker Events ────────────────────────────────────────

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
          let msg = `${icon} **Docker [${c.Names}]** state changed: \`${prev.state}\` → \`${c.State}\``;
          msg += `\n   Image: \`${c.Image}\` │ Status: \`${c.Status}\``;

          if (c.State === 'exited' || c.State === 'dead') {
            msg += `\n${alertMention()}`;
          }

          await thread.send(msg);
        }
      } catch {
        /* skip */
      }
    }

    previousDockerStates = currentStates;
  } catch (err) {
    logger.error(`Docker event watch error: ${err.message}`);
  }
}

// ── UFW Log ──────────────────────────────────────────────

async function watchUfwLog() {
  const thread = resources.threads['logs-security'];
  if (!thread) return;

  try {
    const logPath = logPaths.resolve().ufw;
    if (!logPath) return; // UFW log not found
    const state = getState();

    let fileSize;
    try {
      const stat = await fs.stat(logPath);
      fileSize = stat.size;
    } catch {
      return;
    }

    const offset = state.logOffsets.ufw || 0;
    if (fileSize <= offset) return;

    const effectiveOffset = fileSize < offset ? 0 : offset;

    const { stdout, success } = await safeExec(
      'bash',
      ['-c', `sudo tail -c +${effectiveOffset + 1} ${logPath} | head -c 30000`],
      { timeout: 5000 }
    );

    if (success && stdout.trim()) {
      const lines = stdout.trim().split('\n');
      const allBlocks = lines.filter((l) => /\[UFW BLOCK\]/i.test(l));

      // Filter out routine LAN noise
      const lanNoisePatterns = [
        /DST=224\./, // Multicast
        /DST=255\.255\.255\.255/, // Broadcast
        /PROTO=2\b/, // IGMP
        /PROTO=ICMPv6 TYPE=13[35]/, // IPv6 Neighbor Solicitation/Advertisement
        /PROTO=ICMPv6 TYPE=134/, // IPv6 Router Advertisement
        /DPT=7\b/, // UDP echo (router health check)
        /SRC=fe80:/i, // IPv6 link-local
      ];

      const blocks = allBlocks.filter((l) => !lanNoisePatterns.some((p) => p.test(l)));

      if (blocks.length > 0) {
        await updateState((s) => {
          if (s.dailyAccumulator.ufwBlocks === undefined) {
            s.dailyAccumulator.ufwBlocks = 0;
          }
          s.dailyAccumulator.ufwBlocks += blocks.length;
        });

        // Only alert on massive spikes
        if (blocks.length >= 100) {
          await thread.send(
            `🔥 **UFW SPIKE:** ${blocks.length} blocked connections in recent batch.\nTop blocked:\n\`\`\`\n${blocks.slice(-5).join('\n').substring(0, 1500)}\n\`\`\``
          );
        }
      }
    }

    await updateState((s) => {
      s.logOffsets.ufw = fileSize;
    });
  } catch (err) {
    logger.error(`UFW log watch error: ${err.message}`);
  }
}

module.exports = { init, run };
