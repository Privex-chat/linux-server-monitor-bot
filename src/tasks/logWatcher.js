const fs = require('fs').promises;
const { safeExec } = require('../utils/exec');
const { updateState, getState } = require('../utils/storage');
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
    const logPath = '/var/log/auth.log';

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

    const { stdout, success } = await safeExec('bash', [
      '-c',
      `sudo tail -c +${effectiveOffset + 1} /var/log/auth.log | head -c 50000`,
    ], { timeout: 5000 });

    if (!success || !stdout.trim()) {
      await updateState((s) => { s.logOffsets.auth = fileSize; });
      return;
    }

    const lines = stdout.trim().split('\n');
    const importantLines = lines.filter((l) =>
      /Failed password|Accepted password|sudo:|session opened|session closed|Invalid user|BREAK-IN/i.test(l)
    );

    if (importantLines.length > 0) {
      // Batch into chunks of 10
      for (let i = 0; i < importantLines.length; i += 10) {
        const chunk = importantLines.slice(i, i + 10);
        const formatted = chunk.map((l) => {
          if (/Failed password|Invalid user|BREAK-IN/i.test(l)) return `🔴 ${l}`;
          if (/Accepted password/i.test(l)) return `🟢 ${l}`;
          if (/sudo:/i.test(l)) return `🟡 ${l}`;
          return `⚪ ${l}`;
        });

        await thread.send(`\`\`\`\n${formatted.join('\n').substring(0, 1900)}\n\`\`\``);
      }

      // Alert on high volume of failures
      const failCount = importantLines.filter((l) => /Failed password|Invalid user/i.test(l)).length;
      if (failCount >= 5) {
        await thread.send(`⚠️ <@${config.ALERT_USER_ID}> **${failCount} failed auth attempts** detected in recent log batch.`);
      }
    }

    await updateState((s) => { s.logOffsets.auth = fileSize; });
  } catch (err) {
    logger.error('Auth log watch error:', err.message);
  }
}

// ── Syslog ───────────────────────────────────────────────

async function watchSyslog() {
  const thread = resources.threads['logs-system'];
  if (!thread) return;

  try {
    const state = getState();
    const logPath = '/var/log/syslog';

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

    const { stdout, success } = await safeExec('bash', [
      '-c',
      `sudo tail -c +${effectiveOffset + 1} /var/log/syslog | head -c 50000`,
    ], { timeout: 5000 });

    if (!success || !stdout.trim()) {
      await updateState((s) => { s.logOffsets.syslog = fileSize; });
      return;
    }

    const lines = stdout.trim().split('\n');
    // Only surface errors, warnings, critical events
    const important = lines.filter((l) =>
      /error|fail|critical|panic|oom|killed|segfault|out of memory/i.test(l)
    );

    if (important.length > 0) {
      for (let i = 0; i < important.length; i += 10) {
        const chunk = important.slice(i, i + 10);
        await thread.send(`\`\`\`\n${chunk.join('\n').substring(0, 1900)}\n\`\`\``);
      }
    }

    await updateState((s) => { s.logOffsets.syslog = fileSize; });
  } catch (err) {
    logger.error('Syslog watch error:', err.message);
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
        const { stdout, success } = await safeExec('bash', [
          '-c',
          `sudo tail -c +${effectiveOffset + 1} ${config.NGINX_ERROR_LOG} | head -c 30000`,
        ], { timeout: 5000 });

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
        await updateState((s) => { s.logOffsets.nginx_error = stat.size; });
      }
    } catch { /* file doesn't exist */ }

    // Access log — only flag attack patterns
    try {
      const stat = await fs.stat(config.NGINX_ACCESS_LOG);
      const offset = state.logOffsets.nginx_access || 0;

      if (stat.size > offset) {
        const effectiveOffset = stat.size < offset ? 0 : offset;
        const { stdout, success } = await safeExec('bash', [
          '-c',
          `sudo tail -c +${effectiveOffset + 1} ${config.NGINX_ACCESS_LOG} | head -c 50000`,
        ], { timeout: 5000 });

        if (success && stdout.trim()) {
          const attackPatterns = [
            /(\.\.|%2e%2e)/i,
            /(union\s+select|drop\s+table|insert\s+into)/i,
            /(<script|javascript:|onerror=)/i,
            /(\/etc\/passwd|\/proc\/self)/i,
            /(cmd=|exec=|system\(|shell_exec)/i,
          ];

          const lines = stdout.trim().split('\n');
          const attacks = lines.filter((l) => attackPatterns.some((p) => p.test(l)));

          if (attacks.length > 0) {
            const truncated = attacks.slice(0, 10).map((l) => l.substring(0, 150));
            await thread.send(
              `🛡️ **${attacks.length} suspicious nginx requests detected:**\n<@${config.ALERT_USER_ID}>\n\`\`\`\n${truncated.join('\n')}\n\`\`\``
            );
          }
        }
        await updateState((s) => { s.logOffsets.nginx_access = stat.size; });
      }
    } catch { /* file doesn't exist */ }
  } catch (err) {
    logger.error('Nginx log watch error:', err.message);
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
            msg += `\n<@${config.ALERT_USER_ID}>`;
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
    logger.error('PM2 event watch error:', err.message);
  }
}

// ── Docker Events ────────────────────────────────────────

async function watchDockerEvents() {
  const thread = resources.threads['logs-docker'];
  if (!thread) return;

  try {
    const { stdout, success } = await safeExec(
      'docker',
      ['ps', '-a', '--format', '{{json .}}'],
      { timeout: 10000 }
    );
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
            msg += `\n<@${config.ALERT_USER_ID}>`;
          }

          await thread.send(msg);
        }
      } catch { /* skip */ }
    }

    previousDockerStates = currentStates;
  } catch (err) {
    logger.error('Docker event watch error:', err.message);
  }
}

// ── UFW Log ──────────────────────────────────────────────

async function watchUfwLog() {
  const thread = resources.threads['logs-security'];
  if (!thread) return;

  try {
    const logPath = '/var/log/ufw.log';
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

    const { stdout, success } = await safeExec('bash', [
      '-c',
      `sudo tail -c +${effectiveOffset + 1} ${logPath} | head -c 30000`,
    ], { timeout: 5000 });

    if (success && stdout.trim()) {
      const lines = stdout.trim().split('\n');
      const blocks = lines.filter((l) => /\[UFW BLOCK\]/i.test(l));

      if (blocks.length > 20) {
        // Summarize instead of spamming
        await thread.send(
          `🔥 **UFW:** ${blocks.length} blocked connections in recent batch.\nTop blocked:\n\`\`\`\n${blocks.slice(-5).join('\n').substring(0, 1500)}\n\`\`\``
        );
      } else if (blocks.length > 0) {
        await thread.send(
          `🔥 **UFW blocks (${blocks.length}):**\n\`\`\`\n${blocks.join('\n').substring(0, 1900)}\n\`\`\``
        );
      }
    }

    await updateState((s) => { s.logOffsets.ufw = fileSize; });
  } catch (err) {
    logger.error('UFW log watch error:', err.message);
  }
}

module.exports = { init, run };
