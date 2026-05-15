# Linux Server Monitor Bot

A Discord bot that monitors your Linux server's health, security, and services — real-time stats, intrusion detection, and remote management from a single Discord channel.

## Features

| Category        | What's Monitored                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **System**      | CPU (per-core + total), RAM, swap, disk usage, network I/O, uptime                                                                                                    |
| **Temperature** | CPU package + per-core (lm-sensors), HDD/SSD/NVMe (smartctl)                                                                                                          |
| **Power**       | Intel RAPL energy counters, per-domain wattage, PSU utilization                                                                                                       |
| **Services**    | PM2 processes, Docker containers — status, CPU, memory, restarts                                                                                                      |
| **Security**    | SSH brute force detection, fail2ban bans, UFW firewall, suspicious processes, open port monitoring, rootkit scans (rkhunter), antivirus scans (ClamAV), login history |
| **Web**         | Nginx access log attack detection (SQLi, XSS, LFI, RCE, path traversal, probes), error log monitoring                                                                 |

### Security Features

- Detects SSH brute force attacks with configurable thresholds
- Monitors for crypto miners and suspicious processes
- Scans for rootkits daily (rkhunter)
- Antivirus scanning (ClamAV)
- Flags unexpected open ports
- Detects web application attacks in nginx logs
- Real-time alerts with Discord mentions for WARNING and CRITICAL events
- Audit logging of all dangerous commands

### Beginner-Friendly Commands

Run `!explain` for a plain-English security breakdown, or `!threats` to see only active problems with step-by-step fix instructions. No Linux expertise required.

## Discord Channel Layout

```
#server-monitor
 ├── 📡 LIVE STATS          (updated every ~15s)
 ├── 📊 DAILY SUMMARY       (generated daily)
 ├── 📈 WEEKLY SUMMARY      (generated weekly)
 ├── 🖥️ PM2 STATUS          (updated every ~15s)
 ├── 🐳 DOCKER STATUS       (updated every ~15s)
 ├── 🛡️ SECURITY STATUS     (updated every 5m)
 ├── [Thread] logs-system
 ├── [Thread] logs-docker
 ├── [Thread] logs-pm2
 ├── [Thread] logs-auth
 ├── [Thread] logs-security
 ├── [Thread] logs-nginx
 └── [Thread] logs-power
```

## Prerequisites

- **Linux** server (tested on Ubuntu 22.04/24.04, Debian 12)
- **Node.js** 18+ (`node --version`)
- **PM2** globally installed (`npm i -g pm2`) — optional but recommended
- **Docker** installed — optional, only needed for Docker monitoring

## Quick Start

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application, then go to **Bot**
3. Enable these intents: **Message Content**, **Server Members**
4. Generate an invite URL (OAuth2 > URL Generator) with these permissions:
   - Send Messages, Manage Messages, Embed Links
   - Create Public Threads, Send Messages in Threads
   - Read Message History, Manage Threads, Manage Roles
5. Invite the bot to your Discord server
6. Copy the bot token for the next step

### 2. Clone and Install

```bash
git clone https://github.com/YOUR_USERNAME/linux-server-monitor-bot.git
cd linux-server-monitor-bot
npm install
```

### 3. Install Monitoring Tools

```bash
sudo bash scripts/install-tools.sh
```

Installs: lm-sensors, smartmontools, fail2ban, ClamAV, rkhunter.

### 4. Set Up Permissions

```bash
sudo bash scripts/setup-permissions.sh $USER
```

Configures passwordless sudo for read-only monitoring commands, Docker group, and RAPL power monitoring access.

> Log out and back in after this step for group changes to take effect.

### 5. Configure

```bash
cp .env.example .env
nano .env  # or your preferred editor
```

Set the three required values:

```env
DISCORD_TOKEN=your_bot_token
GUILD_ID=your_discord_server_id
ALERT_USER_ID=your_discord_user_id
```

See [.env.example](.env.example) for all available options.

#### How to find your IDs

- **Guild ID**: Enable Developer Mode in Discord settings, right-click your server name, Copy Server ID
- **User ID**: Right-click your username, Copy User ID

### 6. Start

```bash
# With PM2 (recommended — auto-restart, log management)
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # follow the printed command to enable on boot

# Or run directly
node index.js

# Or development mode (auto-restart on file changes)
npm run dev
```

## Configuration

All settings can be configured via environment variables in `.env`. See [.env.example](.env.example) for the full list.

Key settings:

| Variable                  | Default               | Description                                                  |
| ------------------------- | --------------------- | ------------------------------------------------------------ |
| `DISCORD_TOKEN`           | _required_            | Discord bot token                                            |
| `GUILD_ID`                | _required_            | Discord server ID                                            |
| `ALERT_USER_ID`           | _required_            | Discord user ID for alerts                                   |
| `OWNER_IDS`               | same as ALERT_USER_ID | Comma-separated list of users who can run dangerous commands |
| `TIMEZONE`                | `UTC`                 | Timezone for timestamps and scheduling                       |
| `SSH_FAIL_WARN_THRESHOLD` | `10`                  | Failed SSH attempts before warning                           |
| `SSH_FAIL_CRIT_THRESHOLD` | `50`                  | Failed SSH attempts before critical                          |
| `EXPECTED_PORTS`          | `22,53,80,443`        | Comma-separated ports that should be open                    |
| `POWER_BASE_LOAD_W`       | `33`                  | Non-CPU power draw in watts                                  |
| `PSU_WATTAGE`             | `450`                 | PSU rating for capacity percentage                           |

## Commands

See [COMMANDS.md](COMMANDS.md) for the full reference. Quick overview:

| Command       | Description                                           |
| ------------- | ----------------------------------------------------- |
| `!help`       | List all commands                                     |
| `!status`     | Quick system overview                                 |
| `!explain`    | Plain-English security breakdown                      |
| `!threats`    | Active threats with fix instructions                  |
| `!ssh`        | SSH attack details                                    |
| `!whois <ip>` | Look up an attacker IP                                |
| `!ban <ip>`   | Block an IP via fail2ban                              |
| `!pm2 list`   | PM2 process status                                    |
| `!docker ps`  | Docker container status                               |
| `!exec <cmd>` | Run shell command (owner only, requires confirmation) |

## Security Alert Levels

| Level    | Triggers                                                                      |
| -------- | ----------------------------------------------------------------------------- |
| SECURE   | No issues detected                                                            |
| ADVISORY | Minor anomalies (low SSH attempts)                                            |
| WARNING  | Potential threats — pings owner in Discord                                    |
| CRITICAL | Active threats (crypto miner, rootkit, high-volume brute force) — pings owner |

## Access Control

| Role              | Permissions                                                |
| ----------------- | ---------------------------------------------------------- |
| `@sudo` role      | All read-only and management commands                      |
| Owner (OWNER_IDS) | All commands including dangerous ones (exec, sudo, reboot) |
| Everyone else     | No access                                                  |

The bot auto-creates the `@sudo` role and assigns it to all owners on startup.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full technical breakdown.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Troubleshooting

### Power shows "Collecting..."

RAPL needs two readings to compute a delta. Wait ~30 seconds after startup.

### Temperatures show "N/A"

Run `sudo sensors-detect --auto` and reboot. Ensure lm-sensors is installed.

### Docker monitoring not working

Ensure your user is in the docker group: `groups $USER`. Log out and back in after adding.

### Bot can't read logs

Re-run `sudo bash scripts/setup-permissions.sh $USER`.

### Messages were deleted

The bot auto-recreates deleted placeholder messages and threads on the next update cycle.

### Bot won't start — "Missing required env vars"

Ensure `DISCORD_TOKEN`, `GUILD_ID`, and `ALERT_USER_ID` are all set in your `.env` file.

## License

MIT
