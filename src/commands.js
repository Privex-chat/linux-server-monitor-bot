const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const logger = require('./utils/logger');
const { safeExec } = require('./utils/exec');
const { getState } = require('./utils/storage');
const logPaths = require('./utils/logPaths');

const PREFIX = '!';

// ── Rate limiting ────────────────────────────────────────
const cooldowns = new Map();

function checkCooldown(userId, cmdName, cooldownMs) {
  const key = `${userId}:${cmdName}`;
  const now = Date.now();
  const expiresAt = cooldowns.get(key);
  if (expiresAt && now < expiresAt) {
    const remaining = Math.ceil((expiresAt - now) / 1000);
    return remaining;
  }
  cooldowns.set(key, now + cooldownMs);
  return 0;
}

// Cleanup stale entries every 5 minutes
setInterval(
  () => {
    const now = Date.now();
    for (const [key, exp] of cooldowns) {
      if (now >= exp) cooldowns.delete(key);
    }
  },
  5 * 60 * 1000
);

// ── Access checks ────────────────────────────────────────

function isOwner(msg) {
  return config.OWNER_IDS.includes(msg.author.id);
}

function hasAccess(msg) {
  if (isOwner(msg)) return true;
  const state = getState();
  if (!state.sudoRoleId) return false;
  return msg.member?.roles?.cache?.has(state.sudoRoleId) || false;
}

// ── Audit logging ────────────────────────────────────────
let auditThread = null;

function setAuditThread(thread) {
  auditThread = thread;
}

async function logAudit(msg, cmdName, args) {
  if (!auditThread) return;
  const line = `\`${new Date().toISOString()}\` **${msg.author.tag}** ran \`!${cmdName} ${args.join(' ').substring(0, 150)}\``;
  await auditThread.send(line).catch(() => {});
}

// ── Input validation helpers ─────────────────────────────
const SAFE_NAME_RE = /^[a-zA-Z0-9._-]+$/;

function isValidServiceName(name) {
  return SAFE_NAME_RE.test(name) && name.length <= 100;
}

// ── Dangerous command blocklist ───────────────────────────
const BLOCKED_COMMANDS = [
  { pattern: /rm\s+(-[^\s]*\s+)*\/(\s|$)/, reason: 'Recursive delete of root filesystem' },
  { pattern: /rm\s+-[^\s]*r[^\s]*\s+\//, reason: 'Recursive delete of root filesystem' },
  { pattern: /mkfs/, reason: 'Filesystem format' },
  { pattern: /dd\s+if=/, reason: 'Raw disk write' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:/, reason: 'Fork bomb' },
  { pattern: /shutdown/, reason: 'System shutdown (use !reboot instead)' },
  { pattern: /\binit\s+0\b/, reason: 'System halt' },
  { pattern: /\bhalt\b/, reason: 'System halt' },
  { pattern: /\bpoweroff\b/, reason: 'System poweroff' },
  { pattern: /curl\s.*\|\s*(ba)?sh/, reason: 'Remote code execution via pipe' },
  { pattern: /wget\s.*\|\s*(ba)?sh/, reason: 'Remote code execution via pipe' },
  { pattern: /\bpython[23]?\s+-c\b/, reason: 'Interpreter code execution' },
  { pattern: /\bperl\s+-e\b/, reason: 'Interpreter code execution' },
  { pattern: /\bruby\s+-e\b/, reason: 'Interpreter code execution' },
  { pattern: /\bnode\s+-e\b/, reason: 'Interpreter code execution' },
  { pattern: />\s*\/etc\//, reason: 'Overwriting system config files' },
  { pattern: />\s*\/boot\//, reason: 'Overwriting boot files' },
  { pattern: /\bchmod\s+[0-7]*777\b/, reason: 'World-writable permissions' },
  { pattern: /\bchown\s.*\/etc\//, reason: 'Changing ownership of system files' },
  { pattern: /LD_PRELOAD=/, reason: 'Library injection' },
  { pattern: /crontab\s.*-r\b/, reason: 'Crontab removal' },
  { pattern: /visudo/, reason: 'Sudoers modification' },
  { pattern: />\s*\/dev\/[sh]d/, reason: 'Raw device write' },
  { pattern: /\bwipe\b/, reason: 'Disk wipe utility' },
  { pattern: /\bshred\b/, reason: 'Secure file deletion' },
];

function checkBlockedCommand(command) {
  for (const { pattern, reason } of BLOCKED_COMMANDS) {
    if (pattern.test(command)) return reason;
  }
  return null;
}

// ── Command registry ─────────────────────────────────────
const commands = new Map();

function registerCommand(name, opts) {
  commands.set(name, opts);
  if (opts.aliases) {
    for (const alias of opts.aliases) {
      commands.set(alias, { ...opts, isAlias: true });
    }
  }
}

// ── HELP ─────────────────────────────────────────────────
registerCommand('help', {
  description: 'Show all available commands',
  usage: '!help',
  category: 'General',
  async execute(msg) {
    const categories = {};
    for (const [, cmd] of commands) {
      if (cmd.isAlias) continue;
      const cat = cmd.category || 'Other';
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(`\`${cmd.usage}\` — ${cmd.description}`);
    }

    const lines = [];
    for (const [cat, cmds] of Object.entries(categories)) {
      lines.push(`\n**${cat}**`);
      lines.push(...cmds);
    }

    const embed = new EmbedBuilder()
      .setTitle('📖 Bot Commands')
      .setColor(config.COLORS.CYAN)
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'Only the server owner can run commands' })
      .setTimestamp();

    await msg.reply({ embeds: [embed] });
  },
});

// ── STATUS ───────────────────────────────────────────────
registerCommand('status', {
  description: 'Quick system overview',
  usage: '!status',
  category: 'System',
  async execute(msg) {
    const [cpu, mem, disk, uptime] = await Promise.all([
      safeExec('bash', ['-c', "grep 'cpu ' /proc/stat | awk '{u=$2+$4; t=$2+$4+$5; printf \"%.1f%%\", u/t*100}'"]),
      safeExec('free', ['-h']),
      safeExec('df', ['-h', '/']),
      safeExec('bash', [
        '-c',
        'cat /proc/uptime | awk \'{d=int($1/86400);h=int($1%86400/3600);m=int($1%3600/60); printf "%dd %dh %dm",d,h,m}\'',
      ]),
    ]);

    const memLines = mem.stdout?.trim().split('\n') || [];
    const memInfo = memLines[1]?.trim().split(/\s+/) || [];
    const diskLines = disk.stdout?.trim().split('\n') || [];
    const diskInfo = diskLines[1]?.trim().split(/\s+/) || [];

    const embed = new EmbedBuilder()
      .setTitle('📊 Quick Status')
      .setColor(config.COLORS.GREEN)
      .addFields(
        { name: '🖥️ CPU', value: cpu.stdout || 'N/A', inline: true },
        { name: '⏱️ Uptime', value: uptime.stdout || 'N/A', inline: true },
        { name: '🧠 RAM', value: memInfo.length > 2 ? `${memInfo[2]} / ${memInfo[1]}` : 'N/A', inline: true },
        {
          name: '💾 Disk /',
          value: diskInfo.length > 3 ? `${diskInfo[2]} / ${diskInfo[1]} (${diskInfo[4]})` : 'N/A',
          inline: true,
        }
      )
      .setTimestamp();

    await msg.reply({ embeds: [embed] });
  },
});

// ── TOP ──────────────────────────────────────────────────
registerCommand('top', {
  description: 'Top 10 processes by CPU',
  usage: '!top',
  category: 'System',
  async execute(msg) {
    const { stdout } = await safeExec('ps', ['aux', '--sort=-%cpu', '--no-headers'], { timeout: 5000 });
    const lines = stdout?.trim().split('\n').slice(0, 10) || [];
    const formatted = lines.map((l) => {
      const p = l.trim().split(/\s+/);
      return `${p[2]}% CPU | ${p[3]}% MEM | ${p[0]} | ${p.slice(10).join(' ').substring(0, 50)}`;
    });
    await msg.reply(`\`\`\`\n${formatted.join('\n') || 'No data'}\n\`\`\``);
  },
});

// ── DF ───────────────────────────────────────────────────
registerCommand('df', {
  description: 'Disk usage overview',
  usage: '!df',
  category: 'System',
  async execute(msg) {
    const { stdout } = await safeExec('df', [
      '-h',
      '--output=target,size,used,avail,pcent',
      '-x',
      'tmpfs',
      '-x',
      'devtmpfs',
      '-x',
      'overlay',
    ]);
    await msg.reply(`\`\`\`\n${stdout?.substring(0, 1900) || 'No data'}\n\`\`\``);
  },
});

// ── SSH ──────────────────────────────────────────────────
registerCommand('ssh', {
  description: 'Show SSH failed login details',
  usage: '!ssh',
  category: 'Security',
  async execute(msg) {
    const authLog = logPaths.resolve().auth || '/dev/null';

    // Call sudo directly (not via bash) — matches collector pattern
    const { stdout, stderr, success } = await safeExec('sudo', ['grep', 'Failed password', authLog], {
      timeout: 15000,
    });

    let count = '0';
    let ips = 'None';

    if (!success && stderr && /a password is required|a terminal is required/i.test(stderr)) {
      return msg.reply(
        '❌ **sudo requires a password.** Run `scripts/setup-permissions.sh` to configure passwordless sudo for log access.'
      );
    }

    if (success && stdout?.trim()) {
      const lines = stdout.trim().split('\n');
      count = String(lines.length);

      // Extract IPs from "from <ip>" pattern in log lines
      const ipCounts = {};
      for (const line of lines) {
        const match = line.match(/from\s+([\d.]+)/);
        if (match) ipCounts[match[1]] = (ipCounts[match[1]] || 0) + 1;
      }
      const sorted = Object.entries(ipCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 15);
      if (sorted.length > 0) {
        ips = sorted.map(([ip, c]) => `    ${c} ${ip}`).join('\n');
      }
    }

    const embed = new EmbedBuilder()
      .setTitle('🔐 SSH Failed Attempts')
      .setColor(parseInt(count) > 50 ? config.COLORS.RED : config.COLORS.YELLOW)
      .addFields(
        { name: 'Total Failed', value: count, inline: true },
        { name: 'Top Attacker IPs', value: `\`\`\`\n${ips.substring(0, 1000)}\n\`\`\`` }
      )
      .setTimestamp();

    await msg.reply({ embeds: [embed] });
  },
});

// ── BAN ──────────────────────────────────────────────────
registerCommand('ban', {
  description: 'Ban an IP via fail2ban',
  usage: '!ban <ip>',
  category: 'Security',
  dangerous: true,
  cooldown: config.COOLDOWN_HEAVY_MS,
  async execute(msg, args) {
    const ip = args[0];
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      return msg.reply('❌ Usage: `!ban <ip>` — provide a valid IPv4 address.');
    }
    const { stdout, success } = await safeExec('sudo', ['fail2ban-client', 'set', 'sshd', 'banip', ip]);
    await msg.reply(success ? `✅ Banned \`${ip}\` in sshd jail.` : `❌ Failed: ${stdout}`);
  },
});

// ── UNBAN ────────────────────────────────────────────────
registerCommand('unban', {
  description: 'Unban an IP from fail2ban',
  usage: '!unban <ip>',
  category: 'Security',
  async execute(msg, args) {
    const ip = args[0];
    if (!ip || !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      return msg.reply('❌ Usage: `!unban <ip>` — provide a valid IPv4 address.');
    }
    const { stdout, success } = await safeExec('sudo', ['fail2ban-client', 'set', 'sshd', 'unbanip', ip]);
    await msg.reply(success ? `✅ Unbanned \`${ip}\` from sshd jail.` : `❌ Failed: ${stdout}`);
  },
});

// ── PORTS ────────────────────────────────────────────────
registerCommand('ports', {
  description: 'Show all listening ports',
  usage: '!ports',
  category: 'Security',
  async execute(msg) {
    const { stdout } = await safeExec('ss', ['-tlnp']);
    await msg.reply(`\`\`\`\n${stdout?.substring(0, 1900) || 'No data'}\n\`\`\``);
  },
});

// ── UFW ──────────────────────────────────────────────────
registerCommand('ufw', {
  description: 'Show UFW firewall status & rules',
  usage: '!ufw',
  category: 'Security',
  async execute(msg) {
    const { stdout } = await safeExec('sudo', ['ufw', 'status', 'numbered']);
    await msg.reply(`\`\`\`\n${stdout?.substring(0, 1900) || 'No data'}\n\`\`\``);
  },
});

// ── PM2 ──────────────────────────────────────────────────
registerCommand('pm2', {
  description: 'PM2: list | restart <name> | stop <name> | logs <name>',
  usage: '!pm2 <list|restart|stop|logs> [name]',
  category: 'Services',
  async execute(msg, args) {
    const sub = args[0]?.toLowerCase();

    if (!sub || sub === 'list' || sub === 'ls') {
      const { stdout } = await safeExec('pm2', ['list']);
      return msg.reply(`\`\`\`\n${stdout?.substring(0, 1900) || 'No PM2 processes'}\n\`\`\``);
    }

    const target = args[1];
    if (!target) return msg.reply('❌ Provide a process name/id: `!pm2 restart myapp`');
    if (!isValidServiceName(target)) {
      return msg.reply('❌ Invalid process name (letters, numbers, dots, hyphens, underscores only).');
    }

    if (sub === 'restart') {
      const { stdout, success } = await safeExec('pm2', ['restart', target]);
      return msg.reply(success ? `✅ Restarted PM2 process \`${target}\`.` : `❌ Failed:\n\`\`\`${stdout}\`\`\``);
    }
    if (sub === 'stop') {
      const { stdout, success } = await safeExec('pm2', ['stop', target]);
      return msg.reply(success ? `✅ Stopped PM2 process \`${target}\`.` : `❌ Failed:\n\`\`\`${stdout}\`\`\``);
    }
    if (sub === 'start') {
      const { stdout, success } = await safeExec('pm2', ['start', target]);
      return msg.reply(success ? `✅ Started PM2 process \`${target}\`.` : `❌ Failed:\n\`\`\`${stdout}\`\`\``);
    }
    if (sub === 'logs') {
      const { stdout } = await safeExec('pm2', ['logs', target, '--lines', '30', '--nostream', '--raw'], {
        timeout: 10000,
      });
      return msg.reply(`\`\`\`\n${stdout?.substring(0, 1900) || 'No logs'}\n\`\`\``);
    }

    return msg.reply('❌ Unknown subcommand. Use: `list`, `restart`, `stop`, `start`, `logs`');
  },
});

// ── DOCKER ───────────────────────────────────────────────
registerCommand('docker', {
  description: 'Docker: ps | restart <name> | stop <name> | logs <name>',
  usage: '!docker <ps|restart|stop|logs> [name]',
  category: 'Services',
  async execute(msg, args) {
    const sub = args[0]?.toLowerCase();

    if (!sub || sub === 'ps' || sub === 'list') {
      const { stdout } = await safeExec('docker', [
        'ps',
        '-a',
        '--format',
        'table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}',
      ]);
      return msg.reply(`\`\`\`\n${stdout?.substring(0, 1900) || 'No containers'}\n\`\`\``);
    }

    const target = args[1];
    if (!target) return msg.reply('❌ Provide a container name/id: `!docker restart mycontainer`');
    if (!isValidServiceName(target)) {
      return msg.reply('❌ Invalid container name (letters, numbers, dots, hyphens, underscores only).');
    }

    if (sub === 'restart') {
      const { success } = await safeExec('docker', ['restart', target], { timeout: 30000 });
      return msg.reply(success ? `✅ Restarted container \`${target}\`.` : `❌ Failed to restart \`${target}\`.`);
    }
    if (sub === 'stop') {
      const { success } = await safeExec('docker', ['stop', target], { timeout: 30000 });
      return msg.reply(success ? `✅ Stopped container \`${target}\`.` : `❌ Failed to stop \`${target}\`.`);
    }
    if (sub === 'start') {
      const { success } = await safeExec('docker', ['start', target], { timeout: 15000 });
      return msg.reply(success ? `✅ Started container \`${target}\`.` : `❌ Failed to start \`${target}\`.`);
    }
    if (sub === 'logs') {
      const { stdout } = await safeExec('docker', ['logs', '--tail', '30', target], { timeout: 10000 });
      return msg.reply(`\`\`\`\n${stdout?.substring(0, 1900) || 'No logs'}\n\`\`\``);
    }

    return msg.reply('❌ Unknown subcommand. Use: `ps`, `restart`, `stop`, `start`, `logs`');
  },
});

// ── SERVICE ──────────────────────────────────────────────
registerCommand('service', {
  description: 'Manage systemd services',
  usage: '!service <name> <status|start|stop|restart>',
  category: 'Services',
  dangerous: true,
  cooldown: config.COOLDOWN_DANGEROUS_MS,
  async execute(msg, args) {
    const name = args[0];
    const action = args[1]?.toLowerCase();

    if (!name || !action) return msg.reply('❌ Usage: `!service nginx restart`');

    const allowed = ['status', 'start', 'stop', 'restart', 'enable', 'disable'];
    if (!allowed.includes(action)) {
      return msg.reply(`❌ Allowed actions: ${allowed.map((a) => `\`${a}\``).join(', ')}`);
    }

    // Sanitize service name (letters, numbers, hyphens, underscores, dots only)
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      return msg.reply('❌ Invalid service name.');
    }

    const { stdout, stderr, success } = await safeExec('sudo', ['systemctl', action, name], { timeout: 15000 });
    const output = stdout || stderr || 'Done (no output)';
    await msg.reply(
      `${success ? '✅' : '❌'} \`systemctl ${action} ${name}\`\n\`\`\`\n${output.substring(0, 1800)}\n\`\`\``
    );
  },
});

// ── NGINX ────────────────────────────────────────────────
registerCommand('nginx', {
  description: 'Show nginx status and test config',
  usage: '!nginx',
  aliases: ['ngx'],
  category: 'Services',
  async execute(msg) {
    const [status, test] = await Promise.all([
      safeExec('sudo', ['systemctl', 'status', 'nginx', '--no-pager', '-l'], { timeout: 5000 }),
      safeExec('sudo', ['nginx', '-t'], { timeout: 5000 }),
    ]);

    const statusText = status.stdout?.substring(0, 800) || 'N/A';
    const testText = (test.stderr || test.stdout || 'N/A').trim();

    const embed = new EmbedBuilder()
      .setTitle('🌐 Nginx Status')
      .setColor(testText.includes('successful') ? config.COLORS.GREEN : config.COLORS.RED)
      .addFields(
        { name: 'Service Status', value: `\`\`\`\n${statusText}\n\`\`\`` },
        { name: 'Config Test', value: `\`\`\`\n${testText}\n\`\`\`` }
      )
      .setTimestamp();

    await msg.reply({ embeds: [embed] });
  },
});

// ── Shared exec runner with confirmation ─────────────────
async function runWithConfirmation(msg, command, useSudo) {
  const blockReason = checkBlockedCommand(command);
  if (blockReason) {
    return msg.reply(`🚫 Blocked: ${blockReason}`);
  }

  const prefix = useSudo ? 'sudo ' : '';
  const confirm = await msg.reply(
    `⚠️ **Confirm execution:**\n\`\`\`\n${prefix}${command.substring(0, 200)}\n\`\`\`\nReply \`yes\` within 15s to run, or it will be cancelled.`
  );

  const filter = (m) => config.OWNER_IDS.includes(m.author.id) && m.content.toLowerCase() === 'yes';
  try {
    const collected = await msg.channel.awaitMessages({ filter, max: 1, time: 15000, errors: ['time'] });
    if (collected.size === 0) {
      return confirm.edit('❌ Cancelled (no confirmation).');
    }
  } catch {
    return confirm.edit('❌ Cancelled (timed out).');
  }

  await confirm.edit(`⏳ Running: \`${prefix}${command.substring(0, 100)}\`...`);

  const execArgs = useSudo ? ['sudo', ['bash', '-c', command]] : ['bash', ['-c', command]];
  const { stdout, stderr, success } = await safeExec(execArgs[0], execArgs[1], {
    timeout: config.COMMAND_TIMEOUT_LONG_MS,
  });

  // Detect sudo password prompt failure
  if (!success && stderr && /a password is required|a terminal is required/i.test(stderr)) {
    return confirm.edit(
      `❌ **sudo requires a password.**\nThe bot's Linux user needs passwordless sudo configured.\nRun \`sudo visudo\` and add:\n\`\`\`\n${config.PM2_USER || 'botuser'} ALL=(ALL) NOPASSWD: ALL\n\`\`\`\nOr use \`scripts/setup-permissions.sh\` for a locked-down config.`
    );
  }

  const output = (stdout || stderr || '(no output)').substring(0, config.MAX_DISCORD_MSG_LENGTH - 100);

  await confirm.edit(`${success ? '✅' : '❌'} \`${prefix}${command.substring(0, 80)}\`\n\`\`\`\n${output}\n\`\`\``);
}

// ── EXEC (dangerous — owner only, with confirmation) ────
registerCommand('exec', {
  description: 'Run a shell command (⚠️ dangerous, requires confirmation)',
  usage: '!exec <command>',
  category: '⚠️ Dangerous',
  dangerous: true,
  cooldown: config.COOLDOWN_DANGEROUS_MS,
  async execute(msg, args) {
    const command = args.join(' ');
    if (!command) return msg.reply('❌ Usage: `!exec <command>`');
    await runWithConfirmation(msg, command, false);
  },
});

// ── SUDO (dangerous — owner only, with confirmation) ────
registerCommand('sudo', {
  description: 'Run a command with sudo (⚠️ dangerous, requires confirmation)',
  usage: '!sudo <command>',
  category: '⚠️ Dangerous',
  dangerous: true,
  cooldown: config.COOLDOWN_DANGEROUS_MS,
  async execute(msg, args) {
    const command = args.join(' ');
    if (!command) return msg.reply('❌ Usage: `!sudo <command>`');
    await runWithConfirmation(msg, command, true);
  },
});

// ── REBOOT ───────────────────────────────────────────────
registerCommand('reboot', {
  description: 'Reboot the server (requires confirmation)',
  usage: '!reboot',
  category: '⚠️ Dangerous',
  dangerous: true,
  cooldown: config.COOLDOWN_DANGEROUS_MS,
  async execute(msg) {
    const confirm = await msg.reply(
      '⚠️ **Are you sure you want to reboot the server?** Reply `yes` within 15 seconds to confirm.'
    );

    const filter = (m) => config.OWNER_IDS.includes(m.author.id) && m.content.toLowerCase() === 'yes';
    try {
      const collected = await msg.channel.awaitMessages({ filter, max: 1, time: 15000, errors: ['time'] });
      if (collected.size > 0) {
        await msg.channel.send('🔄 **Rebooting server NOW...**');
        await safeExec('sudo', ['reboot'], { timeout: 5000 });
      }
    } catch {
      await confirm.edit('⚠️ Reboot cancelled (timed out).');
    }
  },
});

// ── LOGS ─────────────────────────────────────────────────
registerCommand('logs', {
  description: 'View recent system logs',
  usage: '!logs [syslog|auth|nginx|ufw] [lines]',
  category: 'System',
  async execute(msg, args) {
    const paths = logPaths.resolve();
    const logMap = {
      syslog: paths.syslog,
      auth: paths.auth,
      nginx: paths.nginxError,
      'nginx-access': paths.nginxAccess,
      ufw: paths.ufw,
    };

    const logName = args[0]?.toLowerCase() || 'syslog';
    const lines = Math.min(parseInt(args[1]) || 20, 50);
    const logPath = logMap[logName];

    if (!logPath) {
      return msg.reply(
        `❌ Unknown log. Available: ${Object.keys(logMap)
          .map((k) => `\`${k}\``)
          .join(', ')}`
      );
    }

    const { stdout } = await safeExec('sudo', ['tail', `-${lines}`, logPath], { timeout: 5000 });
    await msg.reply(
      `📋 **${logName}** (last ${lines} lines):\n\`\`\`\n${(stdout || 'Empty/no access').substring(0, 1900)}\n\`\`\``
    );
  },
});

// ── PING ─────────────────────────────────────────────────
registerCommand('ping', {
  description: 'Check bot latency',
  usage: '!ping',
  category: 'General',
  async execute(msg) {
    const start = Date.now();
    const reply = await msg.reply('🏓 Pinging...');
    const latency = Date.now() - start;
    await reply.edit(`🏓 Pong! **${latency}ms** latency | API: **${msg.client.ws.ping}ms**`);
  },
});

// ── CLEAR ───────────────────────────────────────────────
registerCommand('clear', {
  description: 'Push chat history off-screen (like terminal clear)',
  usage: '!clear',
  aliases: ['cls'],
  category: 'General',
  async execute(msg) {
    const blank = '​\n'.repeat(50);
    await msg.channel.send(`${blank}**───── ✨ Cleared ─────**`);
  },
});

// ── EXPLAIN (beginner-friendly security breakdown) ───────
registerCommand('explain', {
  description: 'Explain current security status in simple terms',
  usage: '!explain',
  aliases: ['wtf', 'whatsup', 'report'],
  category: '📖 Explain',
  cooldown: config.COOLDOWN_HEAVY_MS,
  async execute(msg) {
    const reply = await msg.reply('🔍 Analyzing your server security...');
    const authLog = logPaths.resolve().auth || '/dev/null';

    // Gather all security data
    const [sshCountResult, f2bResult, ufwResult, portsResult, procsResult, loginsResult] = await Promise.all([
      safeExec('sudo', ['grep', '-c', 'Failed password', authLog], { timeout: 5000 }),
      safeExec('sudo', ['fail2ban-client', 'status'], { timeout: 5000 }),
      safeExec('sudo', ['ufw', 'status', 'verbose'], { timeout: 5000 }),
      safeExec('ss', ['-tlnp'], { timeout: 5000 }),
      safeExec('ps', ['aux', '--sort=-%cpu', '--no-headers'], { timeout: 5000 }),
      safeExec('sudo', ['grep', 'Failed password', authLog], { timeout: 5000 }),
    ]);

    const sshFails = parseInt(sshCountResult.stdout?.trim()) || 0;
    const lines = [];

    // ── SSH Section ──
    lines.push('**🔐 SSH (Remote Login Attempts)**');
    if (sshFails === 0) {
      lines.push('✅ Nobody has tried to break into your server via SSH. All good!');
    } else if (sshFails < 10) {
      lines.push(`✅ **${sshFails} failed login attempts** — this is normal internet background noise.`);
      lines.push('   Bots constantly scan the internet trying common passwords. This is not a targeted attack.');
    } else if (sshFails < 50) {
      lines.push(`⚠️ **${sshFails} failed login attempts** — slightly above average.`);
      lines.push('   **Who:** Automated bots scanning for weak passwords.');
      lines.push('   **Risk:** Low if you use strong passwords or SSH keys.');
      lines.push('   **Fix:** fail2ban is blocking repeat offenders automatically.');
    } else {
      lines.push(`🔴 **${sshFails} failed login attempts** — high volume!`);
      lines.push('   **Who:** Could be a targeted brute-force attack.');
      lines.push("   **Risk:** Medium — they're trying many password combinations.");
      lines.push('   **Fix:** Make sure you use SSH keys, not passwords. Run `!ssh` to see which IPs are attacking.');
    }

    // Top attackers
    if (loginsResult.success && loginsResult.stdout?.trim()) {
      const counts = {};
      for (const line of loginsResult.stdout.split('\n')) {
        const match = line.match(/from\s+([^\s]+)/);
        if (match) counts[match[1]] = (counts[match[1]] || 0) + 1;
      }
      const topIPs = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      if (topIPs.length > 0 && sshFails > 0) {
        lines.push('\n   **Top attackers:**');
        for (const [ip, c] of topIPs) {
          lines.push(`   • \`${ip}\` tried **${c} times**`);
        }
      }
    }

    // ── Firewall Section ──
    lines.push('\n**🔥 Firewall (UFW)**');
    if (ufwResult.success && ufwResult.stdout?.includes('active')) {
      lines.push('✅ Your firewall is **ON** and protecting your server.');
      lines.push("   It blocks all incoming connections except the ports you've allowed.");
    } else {
      lines.push('🔴 Your firewall appears to be **OFF**!');
      lines.push('   **Risk:** Anyone on the internet can try to connect to any service on your server.');
      lines.push('   **Fix:** Run `!sudo ufw enable` to turn it on.');
    }

    // ── fail2ban Section ──
    lines.push('\n**🚫 fail2ban (Auto-Blocker)**');
    if (f2bResult.success) {
      const bannedMatch = f2bResult.stdout?.match(/Currently banned:\s*(\d+)/g);
      const totalBanned = bannedMatch ? bannedMatch.reduce((sum, m) => sum + parseInt(m.match(/\d+/)[0]), 0) : 0;

      if (totalBanned > 0) {
        lines.push(
          `🛡️ **${totalBanned} IP(s) currently blocked** — fail2ban caught them trying to break in and locked them out.`
        );
      } else {
        lines.push('✅ No IPs currently blocked. fail2ban is running and watching.');
      }
    } else {
      lines.push("⚠️ fail2ban doesn't seem to be running.");
      lines.push('   **Fix:** Run `!service fail2ban start`');
    }

    // ── Open Ports Section ──
    lines.push('\n**🌐 Open Ports (Doors Into Your Server)**');
    const portLines = portsResult.stdout?.trim().split('\n').slice(1) || [];
    const openPorts = [];
    for (const pl of portLines) {
      const match = pl.match(/:(\d+)\s/);
      if (match) openPorts.push(parseInt(match[1]));
    }
    const uniquePorts = [...new Set(openPorts)].filter((p) => p < 49152).sort((a, b) => a - b);

    const portExplanations = {
      22: 'SSH (remote login)',
      53: 'DNS (name resolution)',
      80: 'HTTP (web traffic)',
      443: 'HTTPS (secure web)',
      3306: 'MySQL database',
      5432: 'PostgreSQL database',
      5433: 'PostgreSQL (alt port)',
      6379: 'Redis (cache/database)',
      8080: 'Web app',
      8081: 'Web app',
      8000: 'Web app',
      9090: 'Monitoring/Admin UI',
    };

    if (uniquePorts.length > 0) {
      const explained = uniquePorts.slice(0, 12).map((p) => {
        const desc = portExplanations[p] || (config.EXPECTED_PORTS.includes(p) ? 'Your service' : '⚠️ Unknown');
        return `   • Port **${p}** — ${desc}`;
      });
      lines.push(explained.join('\n'));

      const unexpected = uniquePorts.filter((p) => !config.EXPECTED_PORTS.includes(p));
      if (unexpected.length > 0) {
        lines.push(`\n   ⚠️ **${unexpected.length} unexpected port(s):** ${unexpected.join(', ')}`);
        lines.push("   If you don't recognize these, run `!ports` for details.");
      } else {
        lines.push('   ✅ All ports are in your expected list.');
      }
    }

    // ── Suspicious Processes ──
    lines.push('\n**👀 Suspicious Processes**');
    const procLines = procsResult.stdout?.trim().split('\n').slice(0, 15) || [];
    const minerPatterns = [/xmrig/i, /minerd/i, /cpuminer/i, /cryptonight/i];
    const miners = procLines.filter((l) => minerPatterns.some((p) => p.test(l)));
    const highCpu = procLines.filter((l) => {
      const cpu = parseFloat(l.trim().split(/\s+/)[2]);
      return cpu > 80;
    });

    if (miners.length > 0) {
      lines.push('🔴 **CRYPTO MINER DETECTED!** Someone may have installed mining software on your server.');
      lines.push('   **What:** A program using your CPU to mine cryptocurrency for an attacker.');
      lines.push('   **Fix:** Run `!top` to find the process, then `!exec kill <PID>` to stop it.');
    } else if (highCpu.length > 0) {
      lines.push(`⚠️ ${highCpu.length} process(es) using high CPU. Probably normal, but check with \`!top\`.`);
    } else {
      lines.push('✅ No suspicious processes found. Everything looks normal.');
    }

    // ── Overall Verdict ──
    lines.push('\n─────────────────────────────');
    const issues = [];
    if (sshFails >= 50) issues.push('high SSH attempts');
    if (miners.length > 0) issues.push('crypto miner');
    if (!ufwResult.stdout?.includes('active')) issues.push('firewall off');

    if (issues.length === 0) {
      lines.push('✅ **Overall: Your server looks healthy and secure.**');
    } else {
      lines.push(`⚠️ **Issues found: ${issues.join(', ')}** — see details above for fixes.`);
    }

    // Split into multiple messages if needed (Discord 2000 char limit)
    const fullText = lines.join('\n');
    if (fullText.length > 1900) {
      const mid = fullText.lastIndexOf('\n', 1900);
      await reply.edit(fullText.substring(0, mid));
      await msg.channel.send(fullText.substring(mid));
    } else {
      await reply.edit(fullText);
    }
  },
});

// ── THREATS (active dangers only) ────────────────────────
registerCommand('threats', {
  description: 'Show only active threats and what to do about them',
  usage: '!threats',
  aliases: ['danger', 'alerts'],
  category: '📖 Explain',
  async execute(msg) {
    const authLog = logPaths.resolve().auth || '/dev/null';
    const [sshCountResult, , procsResult] = await Promise.all([
      safeExec('sudo', ['grep', '-c', 'Failed password', authLog], { timeout: 5000 }),
      safeExec('sudo', ['fail2ban-client', 'status', 'sshd'], { timeout: 5000 }),
      safeExec('ps', ['aux', '--sort=-%cpu', '--no-headers'], { timeout: 5000 }),
    ]);

    const sshFails = parseInt(sshCountResult.stdout?.trim()) || 0;
    const threats = [];

    // SSH brute force
    if (sshFails >= 10) {
      const severity = sshFails >= 50 ? '🔴 HIGH' : '🟡 LOW';
      const threat = {
        name: 'SSH Brute Force Attack',
        severity,
        what: `${sshFails} failed login attempts detected.`,
        who: 'Automated bots trying common username/password combos.',
        when: 'Ongoing — check `!ssh` for latest.',
        where: 'SSH service (port 22)',
        fix: [
          '`!ban <ip>` — manually block a specific attacker IP',
          'fail2ban is already auto-blocking repeat offenders',
          'For permanent protection: switch to SSH key auth (disable password login)',
        ],
      };
      threats.push(threat);
    }

    // Crypto miners
    const procLines = procsResult.stdout?.trim().split('\n') || [];
    const minerPatterns = [/xmrig/i, /minerd/i, /cpuminer/i, /cryptonight/i, /stratum/i];
    const miners = procLines.filter((l) => minerPatterns.some((p) => p.test(l)));
    if (miners.length > 0) {
      threats.push({
        name: 'Crypto Miner Detected',
        severity: '🔴 CRITICAL',
        what: 'A crypto mining program is running on your server, using your CPU and electricity.',
        who: 'An attacker who gained access to your server.',
        when: 'Active RIGHT NOW.',
        where: `Process: ${miners[0].trim().split(/\s+/).slice(10).join(' ').substring(0, 60)}`,
        fix: [
          '`!top` — find the process and note its PID (second column)',
          '`!exec kill -9 <PID>` — kill it immediately',
          'Change all your passwords',
          'Check `!logs auth` for how they got in',
        ],
      });
    }

    // Build response
    if (threats.length === 0) {
      const embed = new EmbedBuilder()
        .setTitle('🛡️ No Active Threats')
        .setColor(config.COLORS.GREEN)
        .setDescription(
          "✅ **Your server has no active threats right now.**\n\nEverything looks good! The bot is continuously watching for:\n• SSH brute force attacks\n• Malware and crypto miners\n• Suspicious processes\n• Unauthorized access\n\nYou'll get pinged immediately if anything comes up."
        )
        .setTimestamp();

      return msg.reply({ embeds: [embed] });
    }

    const embeds = threats.map((t) => {
      return new EmbedBuilder()
        .setTitle(`${t.severity} — ${t.name}`)
        .setColor(
          t.severity.includes('CRITICAL')
            ? config.COLORS.RED
            : t.severity.includes('HIGH')
              ? config.COLORS.ORANGE
              : config.COLORS.YELLOW
        )
        .addFields(
          { name: '❓ What is happening?', value: t.what },
          { name: '👤 Who is doing this?', value: t.who },
          { name: '🕐 When?', value: t.when },
          { name: '📍 Where?', value: t.where },
          { name: '🔧 How to fix', value: t.fix.map((f) => `• ${f}`).join('\n') }
        )
        .setTimestamp();
    });

    await msg.reply({ content: `⚠️ **${threats.length} active threat(s) found:**`, embeds: embeds.slice(0, 3) });
  },
});

// ── WHOIS (IP lookup) ────────────────────────────────────
registerCommand('whois', {
  description: 'Look up info about an IP address (who is attacking?)',
  usage: '!whois <ip>',
  aliases: ['lookup', 'ip'],
  category: '📖 Explain',
  cooldown: config.COOLDOWN_HEAVY_MS,
  async execute(msg, args) {
    const ip = args[0];
    if (!ip || !/^[\d.]+$/.test(ip)) {
      return msg.reply('❌ Usage: `!whois <ip>` — example: `!whois 192.168.1.1`');
    }

    const reply = await msg.reply(`🔍 Looking up \`${ip}\`...`);

    // Use multiple sources for reliability
    const [whoisResult, geoResult] = await Promise.all([
      safeExec('whois', [ip], { timeout: 10000 }),
      safeExec(
        'bash',
        [
          '-c',
          `curl -s "http://ip-api.com/json/${ip}?fields=status,country,regionName,city,isp,org,as,query" 2>/dev/null`,
        ],
        { timeout: 10000 }
      ),
    ]);

    const lines = [];

    // Parse geo data
    if (geoResult.success && geoResult.stdout?.trim()) {
      try {
        const geo = JSON.parse(geoResult.stdout);
        if (geo.status === 'success') {
          lines.push(`🌍 **Location:** ${geo.city || '?'}, ${geo.regionName || '?'}, ${geo.country || '?'}`);
          lines.push(`🏢 **ISP:** ${geo.isp || 'Unknown'}`);
          lines.push(`🏛️ **Organization:** ${geo.org || 'Unknown'}`);
          lines.push(`📡 **Network:** ${geo.as || 'Unknown'}`);
        }
      } catch {
        /* parse error */
      }
    }

    // Parse whois for abuse contact
    if (whoisResult.success && whoisResult.stdout) {
      const abuseMatch = whoisResult.stdout.match(/abuse.*?:\s*(.*)/im);
      const netNameMatch =
        whoisResult.stdout.match(/NetName:\s*(.*)/im) || whoisResult.stdout.match(/netname:\s*(.*)/im);

      if (netNameMatch) lines.push(`🏷️ **Network Name:** ${netNameMatch[1].trim()}`);
      if (abuseMatch) lines.push(`📧 **Report abuse to:** ${abuseMatch[1].trim()}`);
    }

    if (lines.length === 0) {
      lines.push('Could not find info for this IP. It may be a private/local address.');
    }

    // Check if this IP has attacked us
    const whoisAuthLog = logPaths.resolve().auth || '/dev/null';
    const attackResult = await safeExec('sudo', ['grep', '-c', ip, whoisAuthLog], { timeout: 5000 });
    const attackCount = parseInt(attackResult.stdout?.trim()) || 0;
    if (attackCount > 0) {
      lines.push(`\n⚔️ **This IP appears ${attackCount} time(s) in your auth log.**`);
    }

    // Check if banned
    const banResult = await safeExec('sudo', ['fail2ban-client', 'status', 'sshd'], { timeout: 5000 });
    if (banResult.success && banResult.stdout?.includes(ip)) {
      lines.push(`🚫 **This IP is currently BANNED by fail2ban.**`);
    }

    const embed = new EmbedBuilder()
      .setTitle(`🔍 IP Lookup: ${ip}`)
      .setColor(config.COLORS.BLUE)
      .setDescription(lines.join('\n'))
      .setFooter({ text: 'Use !ban <ip> to block this address' })
      .setTimestamp();

    await reply.edit({ content: null, embeds: [embed] });
  },
});

// ── Error sanitization ───────────────────────────────────
function sanitizeError(message) {
  const patterns = [
    [/\/home\/\S+/g, '/home/***'],
    [/\/etc\/\S+/g, '/etc/***'],
    [/\/var\/\S+/g, '/var/***'],
    [/\/root\/\S+/g, '/root/***'],
    [/password\S*/gi, 'password***'],
    [/token\S*/gi, 'token***'],
    [/\b\d{1,3}(\.\d{1,3}){3}\b/g, '***.***.***.***'],
  ];
  let sanitized = message;
  for (const [pat, rep] of patterns) {
    sanitized = sanitized.replace(pat, rep);
  }
  return sanitized.substring(0, 200);
}

// ── Handler ──────────────────────────────────────────────

async function handleMessage(msg) {
  if (msg.author.bot) return;
  if (!msg.content.startsWith(PREFIX)) return;

  const content = msg.content.slice(PREFIX.length).trim();
  const args = content.split(/\s+/);
  const cmdName = args.shift().toLowerCase();

  const cmd = commands.get(cmdName);
  if (!cmd) return;

  if (!hasAccess(msg)) {
    return msg.reply('🚫 You need the `sudo` role to use bot commands.');
  }

  if (cmd.dangerous && !isOwner(msg)) {
    return msg.reply('🚫 Only the server owner can run dangerous commands.');
  }

  // Rate limiting
  const cooldownMs = cmd.cooldown || config.COOLDOWN_DEFAULT_MS;
  const remaining = checkCooldown(msg.author.id, cmdName, cooldownMs);
  if (remaining > 0) {
    return msg.reply(`⏳ Cooldown: wait **${remaining}s** before using \`!${cmdName}\` again.`);
  }

  try {
    logger.info(`Command: !${cmdName} ${args.join(' ')} (by ${msg.author.tag})`);
    if (cmd.dangerous) logAudit(msg, cmdName, args);
    await cmd.execute(msg, args);
  } catch (err) {
    logger.error(err, `Command error (!${cmdName})`);
    const safeMsg = sanitizeError(err.message || 'Unknown error');
    await msg.reply(`❌ Command failed: ${safeMsg}`).catch(() => {});
  }
}

module.exports = { handleMessage, setAuditThread };
