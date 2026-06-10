const { EmbedBuilder } = require('discord.js');
const config = require('../../config');

// ── Helpers ──────────────────────────────────────────────

function progressBar(percent, length = 10) {
  const filled = Math.round((percent / 100) * length);
  return '▓'.repeat(Math.min(filled, length)) + '░'.repeat(Math.max(0, length - filled));
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / k ** i).toFixed(1)} ${sizes[i]}`;
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

function localNow() {
  return new Date().toLocaleString('en-US', { timeZone: config.TIMEZONE, hour12: false });
}

// Keep old name as alias for compatibility
const istNow = localNow;

// ── Live Stats Embed ─────────────────────────────────────

function buildLiveStatsEmbed(system, temps, power) {
  const cpu = system.cpu;
  const mem = system.memory;

  const cpuBar = progressBar(cpu.total);
  const memPercent = mem.total > 0 ? (mem.used / mem.total) * 100 : 0;
  const memBar = progressBar(memPercent);

  let diskText = '';
  for (const d of system.disks.slice(0, 4)) {
    const pct = d.total > 0 ? (d.used / d.total) * 100 : 0;
    diskText += `\`${d.mount}\` ${progressBar(pct, 8)} ${formatBytes(d.used)}/${formatBytes(d.total)} (${Math.round(pct)}%)\n`;
  }

  let tempText = 'N/A';
  if (temps.available) {
    const parts = [];
    if (temps.cpu.package !== null) parts.push(`CPU: ${temps.cpu.package}°C`);
    for (const drive of temps.drives) {
      parts.push(`${drive.device}: ${drive.temp}°C`);
    }
    tempText = parts.join(' │ ') || 'N/A';
  }

  let powerText = 'Collecting...';
  if (power.available) {
    powerText = `${power.package}W (pkg)`;
    if (power.dram > 0) powerText += ` + ${power.dram}W (dram)`;
    powerText += ` │ ~${power.estimatedTotal}W total (${power.psuPercent}% of ${config.PSU_WATTAGE}W PSU)`;
  }

  let netText = '';
  for (const iface of system.network.interfaces.slice(0, 3)) {
    netText += `\`${iface.name}\` ↑ ${iface.txSpeed} Mbps  ↓ ${iface.rxSpeed} Mbps\n`;
  }

  const embed = new EmbedBuilder()
    .setTitle('📡  LIVE SERVER STATS')
    .setColor(config.COLORS.CYAN)
    .setDescription(`Last updated: \`${localNow()}\``)
    .addFields(
      {
        name: '🖥️ CPU',
        value: `\`${cpuBar}\` **${cpu.total}%** │ Load: \`${cpu.loadAvg}\``,
        inline: false,
      },
      {
        name: '🧠 RAM',
        value: `\`${memBar}\` **${formatBytes(mem.used)}** / ${formatBytes(mem.total)} (${Math.round(memPercent)}%)${mem.swapUsed > 0 ? `\nSwap: ${formatBytes(mem.swapUsed)} / ${formatBytes(mem.swapTotal)}` : ''}`,
        inline: false,
      },
      {
        name: '💾 Disk',
        value: diskText || 'N/A',
        inline: false,
      },
      {
        name: '🌡️ Temperature',
        value: tempText,
        inline: false,
      },
      {
        name: '⚡ Power',
        value: powerText,
        inline: false,
      },
      {
        name: '🌐 Network',
        value: netText || 'N/A',
        inline: false,
      },
      {
        name: '⏱️ Uptime',
        value: system.uptime,
        inline: true,
      }
    )
    .setFooter({ text: 'Refreshes every 15 seconds' })
    .setTimestamp();

  return embed;
}

// ── PM2 Status Embed ─────────────────────────────────────

function buildPm2Embed(pm2Data) {
  if (!pm2Data.available) {
    return new EmbedBuilder()
      .setTitle('🖥️  PM2 PROCESSES')
      .setColor(config.COLORS.DARK)
      .setDescription('PM2 is not available or not running.')
      .setTimestamp();
  }

  const statusIcons = {
    online: '🟢',
    stopping: '🟡',
    stopped: '🔴',
    errored: '🔴',
    launching: '🟡',
    'one-launch-status': '🟡',
  };

  let tableText = '';
  for (const proc of pm2Data.processes) {
    const icon = statusIcons[proc.status] || '⚪';
    const watchedTag = proc.watched ? ' ⭐' : '';
    const restartWarn = proc.restarts > 5 ? ' ⚠️' : '';
    const memStr = formatBytes(proc.memory);
    const uptimeStr = proc.uptime > 0 ? formatUptime(proc.uptime) : '-';

    tableText += `${icon} **${proc.name}** (id:${proc.id})${watchedTag}\n`;
    tableText += `   CPU: \`${proc.cpu}%\` │ MEM: \`${memStr}\` │ Restarts: \`${proc.restarts}\`${restartWarn} │ Up: \`${uptimeStr}\`\n`;
  }

  return new EmbedBuilder()
    .setTitle('🖥️  PM2 PROCESSES')
    .setColor(pm2Data.processes.some((p) => p.status === 'errored') ? config.COLORS.RED : config.COLORS.GREEN)
    .setDescription(tableText || 'No processes found.')
    .setFooter({ text: `${pm2Data.processes.length} process(es) │ Refreshes every 60s` })
    .setTimestamp();
}

// ── Docker Status Embed ──────────────────────────────────

function buildDockerEmbed(dockerData) {
  if (!dockerData.available) {
    return new EmbedBuilder()
      .setTitle('🐳  DOCKER CONTAINERS')
      .setColor(config.COLORS.DARK)
      .setDescription('Docker is not available or not running.')
      .setTimestamp();
  }

  const stateIcons = { running: '🟢', paused: '🟡', exited: '🔴', created: '⚪', restarting: '🟡', dead: '💀' };

  let text = '';
  for (const c of dockerData.containers) {
    const icon = stateIcons[c.state] || '⚪';
    const watchedTag = c.watched ? ' ⭐' : '';
    text += `${icon} **${c.name}**${watchedTag}\n`;
    text += `   Image: \`${c.image}\` │ Status: \`${c.status}\`\n`;
    if (c.cpuPercent) {
      text += `   CPU: \`${c.cpuPercent}\` │ MEM: \`${c.memUsage}\` (${c.memPercent})\n`;
    }
    if (c.ports) {
      text += `   Ports: \`${c.ports.substring(0, 80)}\`\n`;
    }
  }

  const hasIssues = dockerData.containers.some((c) => c.state === 'exited' || c.state === 'dead');

  return new EmbedBuilder()
    .setTitle('🐳  DOCKER CONTAINERS')
    .setColor(hasIssues ? config.COLORS.ORANGE : config.COLORS.GREEN)
    .setDescription(text || 'No containers found.')
    .setFooter({ text: `${dockerData.containers.length} container(s) │ Refreshes every 60s` })
    .setTimestamp();
}

// ── Security Status Embed ────────────────────────────────

function buildSecurityEmbed(sec) {
  const lines = [];

  lines.push(`**Status:** ${sec.levelEmoji} ${sec.level}`);
  lines.push('');

  // SSH
  lines.push(`🔐 **SSH:** ${sec.ssh.failedCount} failed attempts`);
  if (sec.ssh.failedIPs.length > 0) {
    const topIPs = sec.ssh.failedIPs
      .slice(0, 3)
      .map((i) => `\`${i.ip}\` (${i.count}x)`)
      .join(', ');
    lines.push(`   Top IPs: ${topIPs}`);
  }

  // fail2ban
  if (sec.fail2ban.available) {
    lines.push(`🚫 **fail2ban:** ${sec.fail2ban.currentlyBanned} IP(s) currently banned (${sec.fail2ban.totalBanned} all-time)`);
    for (const jail of sec.fail2ban.jails) {
      lines.push(`   └ \`${jail.name}\`: ${jail.currentlyBanned} banned, ${jail.currentlyFailed} failing`);
    }
  } else {
    lines.push('🚫 **fail2ban:** Not installed');
  }

  // UFW
  if (sec.ufw.available) {
    lines.push(`🔥 **UFW:** ${sec.ufw.status} │ ${sec.ufw.blockedCount} blocks logged`);
  } else {
    lines.push('🔥 **UFW:** Not available');
  }

  // Open ports
  if (sec.openPorts.unexpected.length > 0) {
    const portList = sec.openPorts.unexpected.map((p) => `\`${p.port}\``).join(', ');
    lines.push(`🌐 **Unexpected ports:** ${portList}`);
  } else {
    lines.push(`🌐 **Open ports:** ${sec.openPorts.ports.length} (all expected)`);
  }

  // Suspicious processes
  if (sec.suspiciousProcs.length > 0) {
    lines.push(`👀 **Suspicious processes:** ${sec.suspiciousProcs.length} detected!`);
    for (const p of sec.suspiciousProcs.slice(0, 3)) {
      lines.push(`   └ PID \`${p.pid}\`: ${p.reason} — \`${p.command.substring(0, 60)}\``);
    }
  } else {
    lines.push('👀 **Suspicious procs:** None');
  }

  // Rootkit
  if (sec.rootkit.available) {
    const rkStatus = sec.rootkit.infected ? '⚠️ INFECTED' : `✅ Clean (${sec.rootkit.warnings} warnings)`;
    lines.push(`🔍 **rkhunter:** ${rkStatus}`);
  } else {
    lines.push('🔍 **rkhunter:** Not installed');
  }

  // ClamAV
  if (sec.clamav.available) {
    const avStatus = sec.clamav.infected > 0 ? `⚠️ ${sec.clamav.infected} INFECTED` : '✅ Clean';
    lines.push(`🦠 **ClamAV:** ${avStatus}`);
  } else {
    lines.push('🦠 **ClamAV:** Not installed');
  }

  const colorMap = {
    SECURE: config.COLORS.GREEN,
    ADVISORY: config.COLORS.YELLOW,
    WARNING: config.COLORS.ORANGE,
    CRITICAL: config.COLORS.RED,
  };

  return new EmbedBuilder()
    .setTitle('🛡️  SECURITY STATUS')
    .setColor(colorMap[sec.level] || config.COLORS.DARK)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Refreshes every 5 minutes' })
    .setTimestamp();
}

// ── Daily Summary Embed ──────────────────────────────────

function buildDailySummaryEmbed(data) {
  const lines = [];

  lines.push(`📅 **Date:** ${new Date().toLocaleDateString('en-US', { timeZone: config.TIMEZONE })}`);
  lines.push('');

  if (data.cpuSamples.length > 0) {
    const avgCpu = (data.cpuSamples.reduce((a, b) => a + b, 0) / data.cpuSamples.length).toFixed(1);
    lines.push(`🖥️ **CPU:** Avg ${avgCpu}% │ Peak ${data.peakCpu.toFixed(1)}%`);
  }

  if (data.ramSamples.length > 0) {
    const avgRam = (data.ramSamples.reduce((a, b) => a + b, 0) / data.ramSamples.length).toFixed(1);
    lines.push(`🧠 **RAM:** Avg ${avgRam}% │ Peak ${data.peakRam.toFixed(1)}%`);
  }

  if (data.powerSamples.length > 0) {
    const avgPower = (data.powerSamples.reduce((a, b) => a + b, 0) / data.powerSamples.length).toFixed(1);
    lines.push(`⚡ **Power:** Avg ~${avgPower}W │ Peak ~${data.peakPower.toFixed(1)}W`);
    const kWh = ((avgPower * 24) / 1000).toFixed(2);
    lines.push(`   └ Estimated: ~${kWh} kWh/day`);
  }

  if (data.tempSamples.length > 0) {
    const avgTemp = (data.tempSamples.reduce((a, b) => a + b, 0) / data.tempSamples.length).toFixed(1);
    lines.push(`🌡️ **Temp:** Avg ${avgTemp}°C │ Peak ${data.peakTemp.toFixed(1)}°C`);
  }

  if (data.ufwBlocks > 0 || data.sshFailures > 0) {
    const secLines = [];
    if (data.ufwBlocks > 0) secLines.push(`🔥 ${data.ufwBlocks} UFW blocks`);
    if (data.sshFailures > 0) secLines.push(`🔐 ${data.sshFailures} SSH failures`);
    lines.push(`🛡️ **Security:** ${secLines.join(' │ ')}`);
  }

  lines.push(`🌐 **Network:** ↓ ${formatBytes(data.networkInTotal)} │ ↑ ${formatBytes(data.networkOutTotal)}`);
  lines.push(`📊 **Samples:** ${data.cpuSamples.length}`);

  return new EmbedBuilder()
    .setTitle('📊  DAILY SUMMARY')
    .setColor(config.COLORS.BLUE)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Generated at ${localNow()}` })
    .setTimestamp();
}

// ── Weekly Summary Embed ─────────────────────────────────

function buildWeeklySummaryEmbed(data) {
  const lines = [];

  lines.push(
    `📆 **Week of:** ${data.startTime ? new Date(data.startTime).toLocaleDateString('en-US', { timeZone: config.TIMEZONE }) : 'N/A'}`
  );
  lines.push(`📊 **Days tracked:** ${data.dailySummaries.length}`);
  lines.push('');

  if (data.dailySummaries.length > 0) {
    const allCpu = data.dailySummaries.flatMap((d) => d.cpuSamples || []);
    const allRam = data.dailySummaries.flatMap((d) => d.ramSamples || []);
    const allPower = data.dailySummaries.flatMap((d) => d.powerSamples || []);
    const allTemp = data.dailySummaries.flatMap((d) => d.tempSamples || []);

    if (allCpu.length > 0) {
      const avg = (allCpu.reduce((a, b) => a + b, 0) / allCpu.length).toFixed(1);
      const peak = Math.max(...data.dailySummaries.map((d) => d.peakCpu || 0)).toFixed(1);
      lines.push(`🖥️ **CPU:** Weekly Avg ${avg}% │ Peak ${peak}%`);
    }

    if (allRam.length > 0) {
      const avg = (allRam.reduce((a, b) => a + b, 0) / allRam.length).toFixed(1);
      lines.push(`🧠 **RAM:** Weekly Avg ${avg}%`);
    }

    if (allPower.length > 0) {
      const avg = (allPower.reduce((a, b) => a + b, 0) / allPower.length).toFixed(1);
      const peak = Math.max(...data.dailySummaries.map((d) => d.peakPower || 0)).toFixed(1);
      const kWh = ((avg * 24 * 7) / 1000).toFixed(2);
      lines.push(`⚡ **Power:** Weekly Avg ~${avg}W │ Peak ~${peak}W`);
      lines.push(`   └ Estimated: ~${kWh} kWh/week`);
    }

    if (allTemp.length > 0) {
      const avg = (allTemp.reduce((a, b) => a + b, 0) / allTemp.length).toFixed(1);
      lines.push(`🌡️ **Temp:** Weekly Avg ${avg}°C`);
    }

    const totalUfw = data.dailySummaries.reduce((a, d) => a + (d.ufwBlocks || 0), 0);
    const totalSsh = data.dailySummaries.reduce((a, d) => a + (d.sshFailures || 0), 0);
    if (totalUfw > 0 || totalSsh > 0) {
      const secLines = [];
      if (totalUfw > 0) secLines.push(`🔥 ${totalUfw} UFW blocks`);
      if (totalSsh > 0) secLines.push(`🔐 ${totalSsh} SSH failures`);
      lines.push(`🛡️ **Security:** ${secLines.join(' │ ')}`);
    }

    const totalIn = data.dailySummaries.reduce((a, d) => a + (d.networkInTotal || 0), 0);
    const totalOut = data.dailySummaries.reduce((a, d) => a + (d.networkOutTotal || 0), 0);
    lines.push(`🌐 **Network:** ↓ ${formatBytes(totalIn)} │ ↑ ${formatBytes(totalOut)}`);
  }

  return new EmbedBuilder()
    .setTitle('📈  WEEKLY SUMMARY')
    .setColor(config.COLORS.PURPLE)
    .setDescription(lines.join('\n') || 'No data collected yet.')
    .setFooter({ text: `Generated at ${localNow()}` })
    .setTimestamp();
}

module.exports = {
  buildLiveStatsEmbed,
  buildPm2Embed,
  buildDockerEmbed,
  buildSecurityEmbed,
  buildDailySummaryEmbed,
  buildWeeklySummaryEmbed,
  progressBar,
  formatBytes,
  formatUptime,
  localNow,
  istNow,
};
