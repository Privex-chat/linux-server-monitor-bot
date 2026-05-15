# 🖥️ Ubuntu Server Monitor — Discord Bot

A comprehensive Discord bot that monitors your Ubuntu server's health, performance, security, and services — all from a single Discord channel.

## Features

| Category | What's Monitored |
|----------|-----------------|
| **System** | CPU (per-core + total), RAM, swap, disk usage, network I/O, uptime |
| **Temperature** | CPU package + per-core (lm-sensors), HDD/SSD/NVMe (smartctl) |
| **Power** | Intel RAPL energy counters → watt calculation + total system estimate |
| **PM2** | All processes: status, CPU, memory, restarts, uptime |
| **Docker** | All containers: state, resource usage, ports, image |
| **Security** | SSH brute force, fail2ban bans, UFW blocks, suspicious processes, open ports, rootkit scans, antivirus scans, login history |
| **Nginx** | Access log attack detection (SQLi, XSS, LFI, RCE, probes), error log monitoring |

## Discord Channel Layout

```
#server-monitor
 ├── 📡 LIVE STATS          (edited every 1 min)
 ├── 📊 DAILY SUMMARY       (edited at midnight IST)
 ├── 📈 WEEKLY SUMMARY      (edited Sunday midnight IST)
 ├── 🖥️ PM2 STATUS          (edited every 1 min)
 ├── 🐳 DOCKER STATUS       (edited every 1 min)
 ├── 🛡️ SECURITY STATUS     (edited every 5 min)
 ├── [Thread] logs-system
 ├── [Thread] logs-docker
 ├── [Thread] logs-pm2
 ├── [Thread] logs-auth
 ├── [Thread] logs-security
 ├── [Thread] logs-nginx
 └── [Thread] logs-power
```

## Prerequisites

- **Ubuntu** 20.04+ (tested on 22.04/24.04)
- **Node.js** 18+ (`node --version`)
- **PM2** globally installed (`npm i -g pm2`)
- **Docker** installed (for Docker monitoring)

## Quick Start

### 1. Create Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application → Bot
3. Enable these intents: **Message Content**, **Server Members**, **Presence**
4. Generate invite URL with these permissions:
   - Send Messages
   - Manage Messages
   - Embed Links
   - Create Public Threads
   - Send Messages in Threads
   - Read Message History
   - Manage Threads
5. Invite the bot to your server

### 2. Clone & Install

```bash
cd /home/sonix
git clone <your-repo-url> ubuntu-server-monitor-bot
cd ubuntu-server-monitor-bot
npm install
```

### 3. Install Security Tools

```bash
sudo bash scripts/install-tools.sh
```

This installs: lm-sensors, smartmontools, fail2ban, ClamAV, rkhunter, auditd.

### 4. Set Up Permissions

```bash
sudo bash scripts/setup-permissions.sh sonix
```

This configures:
- RAPL power monitoring (Intel)
- Docker group membership
- Passwordless sudo for read-only monitoring commands
- Data directory

> **Important:** Log out and back in after this step for docker group changes to take effect.

### 5. Configure

```bash
cp .env.example .env
nano .env
```

Set your Discord bot token:
```
DISCORD_TOKEN=your_actual_bot_token_here
GUILD_ID=1498377364231422106
ALERT_USER_ID=1053965380957241344
```

### 6. Start

```bash
# Start with PM2 (recommended)
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # follow the printed command to enable on boot

# Or run directly
node index.js
```

## Configuration

All settings are in `config.js`:

| Setting | Default | Description |
|---------|---------|-------------|
| `LIVE_INTERVAL_MS` | 60000 | Live stats refresh (ms) |
| `SECURITY_INTERVAL_MS` | 300000 | Security status refresh (ms) |
| `LOG_CHECK_INTERVAL_MS` | 30000 | Log file check interval (ms) |
| `POWER_OVERHEAD_MULTIPLIER` | 1.4 | RAPL → total system power multiplier |
| `PSU_WATTAGE` | 450 | PSU rating for % capacity calc |
| `SSH_FAIL_WARN_THRESHOLD` | 10 | Failed SSH attempts before ⚠️ |
| `SSH_FAIL_CRIT_THRESHOLD` | 50 | Failed SSH attempts before 🔴 |
| `EXPECTED_PORTS` | [22,80,443] | Ports that should be open |
| `WATCHED_PM2_IDS` | [1,2] | PM2 processes with ⭐ special monitoring |
| `WATCHED_DOCKER_IDS` | [...] | Docker containers with ⭐ special monitoring |

## Security Alert Levels

| Level | Emoji | Triggers |
|-------|-------|----------|
| SECURE | 🟢 | No issues |
| ADVISORY | 🟡 | Minor anomalies |
| WARNING | 🟠 | Potential threats → pings user |
| CRITICAL | 🔴 | Active threats → pings user |

## Architecture

```
index.js                  ← Entry point, scheduler
├── src/setup.js          ← Auto-creates channel, messages, threads
├── src/collectors/       ← Pure data gathering
│   ├── system.js         ← CPU, RAM, disk, network
│   ├── temperature.js    ← lm-sensors, smartctl
│   ├── power.js          ← Intel RAPL
│   ├── pm2.js            ← PM2 process list
│   ├── docker.js         ← Docker containers
│   ├── security.js       ← Auth, fail2ban, UFW, rootkit, AV
│   └── nginx.js          ← Access/error log analysis
├── src/formatters/
│   └── embeds.js         ← Discord embed builders
├── src/tasks/
│   ├── liveStats.js      ← 1-min loop
│   ├── securityStatus.js ← 5-min loop
│   ├── summaries.js      ← Daily/weekly aggregation
│   ├── securityScan.js   ← Deep scans (rkhunter, ClamAV)
│   └── logWatcher.js     ← Tail & categorize log entries
├── src/utils/
│   ├── exec.js           ← Safe command execution
│   ├── storage.js        ← JSON state persistence
│   └── logger.js         ← Timestamped console logger
└── data/state.json       ← Persisted state (message IDs, etc.)
```

## Troubleshooting

### Power shows "Collecting..."
RAPL needs two readings to compute a delta. Wait 1-2 minutes after startup.

### Temperatures show "N/A"
Run `sudo sensors-detect --auto` and reboot.

### Docker monitoring not working
Make sure your user is in the docker group: `groups sonix`

### Bot can't read logs
Run `sudo bash scripts/setup-permissions.sh sonix` again.

### Message was deleted
The bot auto-recreates deleted placeholder messages on next restart.

## License

MIT
