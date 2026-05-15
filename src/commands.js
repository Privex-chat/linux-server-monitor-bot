const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const logger = require('./utils/logger');
const { safeExec } = require('./utils/exec');
const { formatBytes, formatUptime, istNow } = require('./formatters/embeds');
const { getState } = require('./utils/storage');

const PREFIX = '!';

// ── Access checks ────────────────────────────────────────

// Owner always has access (fallback)
function isOwner(msg) {
  return msg.author.id === config.ALERT_USER_ID;
}

// Check if user has the "sudo" role OR is the owner
function hasAccess(msg) {
  if (isOwner(msg)) return true;
  const state = getState();
  if (!state.sudoRoleId) return false;
  return msg.member?.roles?.cache?.has(state.sudoRoleId) || false;
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
    for (const [name, cmd] of commands) {
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
      safeExec('bash', ['-c', "cat /proc/uptime | awk '{d=int($1/86400);h=int($1%86400/3600);m=int($1%3600/60); printf \"%dd %dh %dm\",d,h,m}'"]),
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
        { name: '💾 Disk /', value: diskInfo.length > 3 ? `${diskInfo[2]} / ${diskInfo[1]} (${diskInfo[4]})` : 'N/A', inline: true },
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
    const { stdout } = await safeExec('df', ['-h', '--output=target,size,used,avail,pcent', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'overlay']);
    await msg.reply(`\`\`\`\n${stdout?.substring(0, 1900) || 'No data'}\n\`\`\``);
  },
});

// ── SSH ──────────────────────────────────────────────────
registerCommand('ssh', {
  description: 'Show SSH failed login details',
  usage: '!ssh',
  category: 'Security',
  async execute(msg) {
    const [countResult, ipsResult] = await Promise.all([
      safeExec('bash', ['-c', "sudo grep -c 'Failed password' /var/log/auth.log 2>/dev/null || echo 0"]),
      safeExec('bash', ['-c', "sudo grep 'Failed password' /var/log/auth.log | grep -oP '\\d+\\.\\d+\\.\\d+\\.\\d+' | sort | uniq -c | sort -rn | head -15"]),
    ]);

    const count = countResult.stdout?.trim() || '0';
    const ips = ipsResult.stdout?.trim() || 'None';

    const embed = new EmbedBuilder()
      .setTitle('🔐 SSH Failed Attempts')
      .setColor(parseInt(count) > 50 ? config.COLORS.RED : config.COLORS.YELLOW)
      .addFields(
        { name: 'Total Failed', value: count, inline: true },
        { name: 'Top IPs (count | IP)', value: `\`\`\`\n${ips.substring(0, 1000)}\n\`\`\`` },
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
      const { stdout } = await safeExec('pm2', ['logs', target, '--lines', '30', '--nostream', '--raw'], { timeout: 10000 });
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
      const { stdout } = await safeExec('docker', ['ps', '-a', '--format', 'table {{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Ports}}']);
      return msg.reply(`\`\`\`\n${stdout?.substring(0, 1900) || 'No containers'}\n\`\`\``);
    }

    const target = args[1];
    if (!target) return msg.reply('❌ Provide a container name/id: `!docker restart mycontainer`');

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
  async execute(msg, args) {
    const name = args[0];
    const action = args[1]?.toLowerCase();

    if (!name || !action) return msg.reply('❌ Usage: `!service nginx restart`');

    const allowed = ['status', 'start', 'stop', 'restart', 'enable', 'disable'];
    if (!allowed.includes(action)) {
      return msg.reply(`❌ Allowed actions: ${allowed.map(a => `\`${a}\``).join(', ')}`);
    }

    // Sanitize service name (letters, numbers, hyphens, underscores, dots only)
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
      return msg.reply('❌ Invalid service name.');
    }

    const { stdout, stderr, success } = await safeExec('sudo', ['systemctl', action, name], { timeout: 15000 });
    const output = stdout || stderr || 'Done (no output)';
    await msg.reply(`${success ? '✅' : '❌'} \`systemctl ${action} ${name}\`\n\`\`\`\n${output.substring(0, 1800)}\n\`\`\``);
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
        { name: 'Config Test', value: `\`\`\`\n${testText}\n\`\`\`` },
      )
      .setTimestamp();

    await msg.reply({ embeds: [embed] });
  },
});

// ── EXEC (dangerous — owner only, with confirmation) ────
registerCommand('exec', {
  description: 'Run a shell command (⚠️ dangerous)',
  usage: '!exec <command>',
  category: '⚠️ Dangerous',
  dangerous: true,
  async execute(msg, args) {
    const command = args.join(' ');
    if (!command) return msg.reply('❌ Usage: `!exec <command>`');

    // Block extremely dangerous commands
    const blocked = [/rm\s+-rf\s+\//, /mkfs/, /dd\s+if=/, /:(){ :|:& };:/, /shutdown/, /init\s+0/, /halt/];
    if (blocked.some((p) => p.test(command))) {
      return msg.reply('🚫 This command is blocked for safety.');
    }

    const reply = await msg.reply(`⏳ Running: \`${command.substring(0, 100)}\`...`);
    const { stdout, stderr, success } = await safeExec('bash', ['-c', command], { timeout: 30000 });
    const output = (stdout || stderr || '(no output)').substring(0, 1800);

    await reply.edit(`${success ? '✅' : '❌'} \`${command.substring(0, 80)}\`\n\`\`\`\n${output}\n\`\`\``);
  },
});

// ── SUDO (dangerous — owner only) ────────────────────────
registerCommand('sudo', {
  description: 'Run a command with sudo (⚠️ dangerous)',
  usage: '!sudo <command>',
  category: '⚠️ Dangerous',
  dangerous: true,
  async execute(msg, args) {
    const command = args.join(' ');
    if (!command) return msg.reply('❌ Usage: `!sudo <command>`');

    const blocked = [/rm\s+-rf\s+\//, /mkfs/, /dd\s+if=/, /:(){ :|:& };:/, /shutdown/, /init\s+0/, /halt/];
    if (blocked.some((p) => p.test(command))) {
      return msg.reply('🚫 This command is blocked for safety.');
    }

    const reply = await msg.reply(`⏳ Running with sudo: \`${command.substring(0, 100)}\`...`);
    const { stdout, stderr, success } = await safeExec('sudo', ['bash', '-c', command], { timeout: 30000 });
    const output = (stdout || stderr || '(no output)').substring(0, 1800);

    await reply.edit(`${success ? '✅' : '❌'} \`sudo ${command.substring(0, 80)}\`\n\`\`\`\n${output}\n\`\`\``);
  },
});

// ── REBOOT ───────────────────────────────────────────────
registerCommand('reboot', {
  description: 'Reboot the server (requires confirmation)',
  usage: '!reboot',
  category: '⚠️ Dangerous',
  dangerous: true,
  async execute(msg) {
    const confirm = await msg.reply('⚠️ **Are you sure you want to reboot the server?** Reply `yes` within 15 seconds to confirm.');

    const filter = (m) => m.author.id === config.ALERT_USER_ID && m.content.toLowerCase() === 'yes';
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
    const logMap = {
      syslog: '/var/log/syslog',
      auth: '/var/log/auth.log',
      nginx: config.NGINX_ERROR_LOG,
      'nginx-access': config.NGINX_ACCESS_LOG,
      ufw: '/var/log/ufw.log',
    };

    const logName = args[0]?.toLowerCase() || 'syslog';
    const lines = Math.min(parseInt(args[1]) || 20, 50);
    const logPath = logMap[logName];

    if (!logPath) {
      return msg.reply(`❌ Unknown log. Available: ${Object.keys(logMap).map(k => `\`${k}\``).join(', ')}`);
    }

    const { stdout } = await safeExec('sudo', ['tail', `-${lines}`, logPath], { timeout: 5000 });
    await msg.reply(`📋 **${logName}** (last ${lines} lines):\n\`\`\`\n${(stdout || 'Empty/no access').substring(0, 1900)}\n\`\`\``);
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

// ── EXPLAIN (beginner-friendly security breakdown) ───────
registerCommand('explain', {
  description: 'Explain current security status in simple terms',
  usage: '!explain',
  aliases: ['wtf', 'whatsup', 'report'],
  category: '📖 Explain',
  async execute(msg) {
    const reply = await msg.reply('🔍 Analyzing your server security...');

    // Gather all security data
    const [sshResult, f2bResult, ufwResult, portsResult, procsResult, loginsResult] = await Promise.all([
      safeExec('bash', ['-c', "sudo grep -c 'Failed password' /var/log/auth.log 2>/dev/null || echo 0"]),
      safeExec('sudo', ['fail2ban-client', 'status'], { timeout: 5000 }),
      safeExec('sudo', ['ufw', 'status', 'verbose'], { timeout: 5000 }),
      safeExec('ss', ['-tlnp'], { timeout: 5000 }),
      safeExec('ps', ['aux', '--sort=-%cpu', '--no-headers'], { timeout: 5000 }),
      safeExec('bash', ['-c', "sudo grep 'Failed password' /var/log/auth.log | grep -oP '\\d+\\.\\d+\\.\\d+\\.\\d+' | sort | uniq -c | sort -rn | head -5"], { timeout: 5000 }),
    ]);

    const sshFails = parseInt(sshResult.stdout?.trim()) || 0;
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
      lines.push('   **Risk:** Medium — they\'re trying many password combinations.');
      lines.push('   **Fix:** Make sure you use SSH keys, not passwords. Run `!ssh` to see which IPs are attacking.');
    }

    // Top attackers
    if (loginsResult.success && loginsResult.stdout?.trim()) {
      const topIPs = loginsResult.stdout.trim().split('\n').slice(0, 3);
      if (topIPs.length > 0 && sshFails > 0) {
        lines.push('\n   **Top attackers:**');
        for (const entry of topIPs) {
          const match = entry.trim().match(/(\d+)\s+([\d.]+)/);
          if (match) {
            lines.push(`   • \`${match[2]}\` tried **${match[1]} times**`);
          }
        }
      }
    }

    // ── Firewall Section ──
    lines.push('\n**🔥 Firewall (UFW)**');
    if (ufwResult.success && ufwResult.stdout?.includes('active')) {
      lines.push('✅ Your firewall is **ON** and protecting your server.');
      lines.push('   It blocks all incoming connections except the ports you\'ve allowed.');
    } else {
      lines.push('🔴 Your firewall appears to be **OFF**!');
      lines.push('   **Risk:** Anyone on the internet can try to connect to any service on your server.');
      lines.push('   **Fix:** Run `!sudo ufw enable` to turn it on.');
    }

    // ── fail2ban Section ──
    lines.push('\n**🚫 fail2ban (Auto-Blocker)**');
    if (f2bResult.success) {
      const bannedMatch = f2bResult.stdout?.match(/Currently banned:\s*(\d+)/g);
      const totalBanned = bannedMatch
        ? bannedMatch.reduce((sum, m) => sum + parseInt(m.match(/\d+/)[0]), 0)
        : 0;

      if (totalBanned > 0) {
        lines.push(`🛡️ **${totalBanned} IP(s) currently blocked** — fail2ban caught them trying to break in and locked them out.`);
      } else {
        lines.push('✅ No IPs currently blocked. fail2ban is running and watching.');
      }
    } else {
      lines.push('⚠️ fail2ban doesn\'t seem to be running.');
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
    const uniquePorts = [...new Set(openPorts)].filter(p => p < 49152).sort((a, b) => a - b);

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
      const explained = uniquePorts.slice(0, 12).map(p => {
        const desc = portExplanations[p] || (config.EXPECTED_PORTS.includes(p) ? 'Your service' : '⚠️ Unknown');
        return `   • Port **${p}** — ${desc}`;
      });
      lines.push(explained.join('\n'));

      const unexpected = uniquePorts.filter(p => !config.EXPECTED_PORTS.includes(p));
      if (unexpected.length > 0) {
        lines.push(`\n   ⚠️ **${unexpected.length} unexpected port(s):** ${unexpected.join(', ')}`);
        lines.push('   If you don\'t recognize these, run `!ports` for details.');
      } else {
        lines.push('   ✅ All ports are in your expected list.');
      }
    }

    // ── Suspicious Processes ──
    lines.push('\n**👀 Suspicious Processes**');
    const procLines = procsResult.stdout?.trim().split('\n').slice(0, 15) || [];
    const minerPatterns = [/xmrig/i, /minerd/i, /cpuminer/i, /cryptonight/i];
    const miners = procLines.filter(l => minerPatterns.some(p => p.test(l)));
    const highCpu = procLines.filter(l => {
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
    const [sshResult, ipsResult, f2bResult, procsResult] = await Promise.all([
      safeExec('bash', ['-c', "sudo grep -c 'Failed password' /var/log/auth.log 2>/dev/null || echo 0"]),
      safeExec('bash', ['-c', "sudo grep 'Failed password' /var/log/auth.log | grep -oP '\\d+\\.\\d+\\.\\d+\\.\\d+' | sort | uniq -c | sort -rn | head -5"]),
      safeExec('sudo', ['fail2ban-client', 'status', 'sshd'], { timeout: 5000 }),
      safeExec('ps', ['aux', '--sort=-%cpu', '--no-headers'], { timeout: 5000 }),
    ]);

    const sshFails = parseInt(sshResult.stdout?.trim()) || 0;
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
    const miners = procLines.filter(l => minerPatterns.some(p => p.test(l)));
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
        .setDescription('✅ **Your server has no active threats right now.**\n\nEverything looks good! The bot is continuously watching for:\n• SSH brute force attacks\n• Malware and crypto miners\n• Suspicious processes\n• Unauthorized access\n\nYou\'ll get pinged immediately if anything comes up.')
        .setTimestamp();

      return msg.reply({ embeds: [embed] });
    }

    const embeds = threats.map((t) => {
      return new EmbedBuilder()
        .setTitle(`${t.severity} — ${t.name}`)
        .setColor(t.severity.includes('CRITICAL') ? config.COLORS.RED : t.severity.includes('HIGH') ? config.COLORS.ORANGE : config.COLORS.YELLOW)
        .addFields(
          { name: '❓ What is happening?', value: t.what },
          { name: '👤 Who is doing this?', value: t.who },
          { name: '🕐 When?', value: t.when },
          { name: '📍 Where?', value: t.where },
          { name: '🔧 How to fix', value: t.fix.map(f => `• ${f}`).join('\n') },
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
  async execute(msg, args) {
    const ip = args[0];
    if (!ip || !/^[\d.]+$/.test(ip)) {
      return msg.reply('❌ Usage: `!whois <ip>` — example: `!whois 192.168.1.1`');
    }

    const reply = await msg.reply(`🔍 Looking up \`${ip}\`...`);

    // Use multiple sources for reliability
    const [whoisResult, geoResult] = await Promise.all([
      safeExec('whois', [ip], { timeout: 10000 }),
      safeExec('bash', ['-c', `curl -s "http://ip-api.com/json/${ip}?fields=status,country,regionName,city,isp,org,as,query" 2>/dev/null`], { timeout: 10000 }),
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
      } catch { /* parse error */ }
    }

    // Parse whois for abuse contact
    if (whoisResult.success && whoisResult.stdout) {
      const abuseMatch = whoisResult.stdout.match(/abuse.*?:\s*(.*)/im);
      const netNameMatch = whoisResult.stdout.match(/NetName:\s*(.*)/im) || whoisResult.stdout.match(/netname:\s*(.*)/im);

      if (netNameMatch) lines.push(`🏷️ **Network Name:** ${netNameMatch[1].trim()}`);
      if (abuseMatch) lines.push(`📧 **Report abuse to:** ${abuseMatch[1].trim()}`);
    }

    if (lines.length === 0) {
      lines.push('Could not find info for this IP. It may be a private/local address.');
    }

    // Check if this IP has attacked us
    const attackResult = await safeExec('bash', ['-c', `sudo grep -c '${ip}' /var/log/auth.log 2>/dev/null || echo 0`]);
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

// ── Handler ──────────────────────────────────────────────

async function handleMessage(msg) {
  // Ignore bots and messages without prefix
  if (msg.author.bot) return;
  if (!msg.content.startsWith(PREFIX)) return;

  const content = msg.content.slice(PREFIX.length).trim();
  const args = content.split(/\s+/);
  const cmdName = args.shift().toLowerCase();

  const cmd = commands.get(cmdName);
  if (!cmd) return;

  // Role check — must have @sudo role (or be the owner)
  if (!hasAccess(msg)) {
    return msg.reply('🚫 You need the `sudo` role to use bot commands.');
  }

  // Dangerous commands require the owner specifically
  if (cmd.dangerous && !isOwner(msg)) {
    return msg.reply('🚫 Only the server owner can run dangerous commands (`exec`, `sudo`, `reboot`, `service`).');
  }

  try {
    logger.info(`Command: !${cmdName} ${args.join(' ')} (by ${msg.author.tag})`);
    await cmd.execute(msg, args);
  } catch (err) {
    logger.error(`Command error (!${cmdName}):`, err.message);
    await msg.reply(`❌ Error: ${err.message}`).catch(() => {});
  }
}

module.exports = { handleMessage };
