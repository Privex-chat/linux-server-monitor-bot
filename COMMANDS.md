# Bot Commands Reference

All commands use the `!` prefix. You must have the `@sudo` role to use commands.

---

## General

| Command | Description                                       |
| ------- | ------------------------------------------------- |
| `!help` | Shows all available commands in Discord           |
| `!ping` | Checks if the bot is responding and shows latency |

---

## System

| Command                | Description                            |
| ---------------------- | -------------------------------------- |
| `!status`              | Quick overview: CPU, RAM, disk, uptime |
| `!top`                 | Top 10 processes by CPU usage          |
| `!df`                  | Disk usage per filesystem              |
| `!logs [type] [lines]` | View recent log entries (max 50 lines) |

### `!logs` types

```
!logs              → syslog (default, last 20 lines)
!logs auth         → authentication log
!logs nginx        → nginx error log
!logs nginx-access → nginx access log
!logs ufw          → firewall log
!logs auth 50      → last 50 lines
```

---

## Explain (Beginner-Friendly)

These commands explain security in plain English — no jargon.

| Command       | Aliases                     | Description                                                     |
| ------------- | --------------------------- | --------------------------------------------------------------- |
| `!explain`    | `!wtf` `!whatsup` `!report` | Full security report: SSH, firewall, fail2ban, ports, processes |
| `!threats`    | `!danger` `!alerts`         | Only active threats with who/what/when/where/fix                |
| `!whois <ip>` | `!lookup` `!ip`             | IP lookup: country, ISP, org, attack history, ban status        |

### Examples

```
!explain              → "What's going on with my server?"
!threats              → "Do I have any problems right now?"
!whois 103.45.67.89   → "Who is attacking me?"
```

---

## Security

| Command       | Description                               |
| ------------- | ----------------------------------------- |
| `!ssh`        | Failed SSH login count + top attacker IPs |
| `!ban <ip>`   | Block an IP via fail2ban (owner only)     |
| `!unban <ip>` | Remove a fail2ban block                   |
| `!ports`      | All listening ports                       |
| `!ufw`        | Firewall rules                            |

### Examples

```
!ssh                  → See attack details
!ban 103.45.67.89     → Block an attacker
!unban 103.45.67.89   → Unblock them
```

---

## Services

| Command                    | Description                             |
| -------------------------- | --------------------------------------- |
| `!pm2 list`                | All PM2 processes with status           |
| `!pm2 restart <name>`      | Restart a PM2 process                   |
| `!pm2 stop <name>`         | Stop a PM2 process                      |
| `!pm2 start <name>`        | Start a PM2 process                     |
| `!pm2 logs <name>`         | Recent PM2 process logs                 |
| `!docker ps`               | All Docker containers                   |
| `!docker restart <name>`   | Restart a container                     |
| `!docker stop <name>`      | Stop a container                        |
| `!docker start <name>`     | Start a container                       |
| `!docker logs <name>`      | Recent container logs                   |
| `!nginx`                   | Nginx service status + config test      |
| `!service <name> <action>` | Systemd service management (owner only) |

Service actions: `status`, `start`, `stop`, `restart`, `enable`, `disable`

### Examples

```
!pm2 list               → Check all Node apps
!pm2 restart my-app      → Restart an app
!docker ps               → Check containers
!docker logs mydb        → View container logs
!nginx                   → Web server health
!service nginx restart   → Restart nginx (owner only)
```

---

## Dangerous Commands (Owner Only)

These commands modify your server. Only users listed in `OWNER_IDS` can run them.

| Command                    | Description                                     |
| -------------------------- | ----------------------------------------------- |
| `!exec <command>`          | Run a shell command (requires confirmation)     |
| `!sudo <command>`          | Run a command with sudo (requires confirmation) |
| `!reboot`                  | Reboot the server (requires confirmation)       |
| `!service <name> <action>` | Start/stop/restart system services              |

### Safety Features

- **Confirmation required**: `!exec`, `!sudo`, and `!reboot` all require typing `yes` within 15 seconds
- **Rate limiting**: 30-second cooldown between dangerous commands
- **Command blocklist**: 25 patterns blocked including `rm -rf /`, `mkfs`, `dd`, `curl|bash`, `python -c`, `chmod 777`, `LD_PRELOAD`, and more
- **Audit logging**: All dangerous commands are logged to the security thread
- **Timeout**: Commands auto-cancel after 30 seconds
- **Input validation**: Service/process names restricted to `[a-zA-Z0-9._-]`

### Examples

```
!exec whoami            → Check which user the bot runs as
!exec free -h           → Detailed RAM usage
!sudo cat /etc/hosts    → View hosts file (requires confirmation)
!reboot                 → Reboot (requires confirmation)
```

---

## Access Control

| Role                 | Can Run                               |
| -------------------- | ------------------------------------- |
| `@sudo` role         | All read-only and management commands |
| Owners (`OWNER_IDS`) | All commands including dangerous ones |
| Everyone else        | No access                             |

- The bot auto-creates the `@sudo` role on startup
- All owners are auto-assigned the `@sudo` role
- Set `OWNER_IDS=id1,id2` in `.env` for multiple owners
- If `OWNER_IDS` is not set, defaults to `ALERT_USER_ID`

---

## Rate Limits

| Command Type                                     | Cooldown   |
| ------------------------------------------------ | ---------- |
| Regular commands                                 | 3 seconds  |
| Heavy commands (`!explain`, `!whois`)            | 10 seconds |
| Dangerous commands (`!exec`, `!sudo`, `!reboot`) | 30 seconds |

---

## Tips

- **Got an SSH warning?** Run `!explain` first for the full picture
- **Suspicious IP?** Run `!whois <ip>` then `!ban <ip>`
- **App crashed?** `!pm2 list` or `!docker ps` to check, then restart
- **Not sure what's wrong?** `!threats` shows only actionable problems
