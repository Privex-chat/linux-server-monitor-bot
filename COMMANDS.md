# 📖 Bot Commands Reference

All commands use the `!` prefix. You must have the `@sudo` role to use commands.

---

## 📋 General

| Command | What It Does |
|---------|-------------|
| `!help` | Shows all available commands in Discord |
| `!ping` | Checks if the bot is responding and shows latency |

---

## 🖥️ System

| Command | What It Does |
|---------|-------------|
| `!status` | Quick overview: CPU usage, RAM, disk space, uptime |
| `!top` | Shows the top 10 programs using the most CPU |
| `!df` | Shows how much disk space is used on each drive |
| `!logs [type] [lines]` | View recent log entries |

### `!logs` Examples
```
!logs              → last 20 lines of syslog
!logs auth         → last 20 lines of auth log (login attempts)
!logs nginx 50     → last 50 lines of nginx error log
!logs ufw          → last 20 lines of firewall log
!logs nginx-access → last 20 lines of nginx access log
```

---

## 📖 Explain (Beginner-Friendly)

These commands explain what's happening in **simple terms** — no technical jargon.

| Command | Aliases | What It Does |
|---------|---------|-------------|
| `!explain` | `!wtf`, `!whatsup`, `!report` | Full security report in plain English. Covers SSH attacks, firewall, fail2ban, open ports, and suspicious programs. Tells you who/what/when/where and what to do. |
| `!threats` | `!danger`, `!alerts` | Shows ONLY active threats with clear who/what/when/where/how-to-fix breakdown as Discord embeds. If nothing's wrong, tells you that too. |
| `!whois <ip>` | `!lookup <ip>`, `!ip <ip>` | Looks up an IP address — shows the country, ISP, organization, and whether they've tried to attack your server. |

### Examples
```
!explain                → Full security breakdown
!threats                → "Do I have any active problems?"
!whois 103.45.67.89     → "Who is this IP that tried to log in?"
```

---

## 🔐 Security

| Command | What It Does |
|---------|-------------|
| `!ssh` | Shows how many failed login attempts there are and which IPs are trying |
| `!ban <ip>` | Blocks an IP address so it can't try to log in anymore |
| `!unban <ip>` | Removes the block from an IP address |
| `!ports` | Lists all open network ports (doors into your server) |
| `!ufw` | Shows your firewall rules (what's allowed/blocked) |

### Examples
```
!ssh                    → See attack details
!ban 103.45.67.89       → Block an attacker
!unban 103.45.67.89     → Unblock them
```

---

## ⚙️ Services

| Command | What It Does |
|---------|-------------|
| `!pm2 list` | Shows all your Node.js apps and their status |
| `!pm2 restart <name>` | Restarts a PM2 app |
| `!pm2 stop <name>` | Stops a PM2 app |
| `!pm2 start <name>` | Starts a PM2 app |
| `!pm2 logs <name>` | Shows recent logs from a PM2 app |
| `!docker ps` | Shows all Docker containers and their status |
| `!docker restart <name>` | Restarts a Docker container |
| `!docker stop <name>` | Stops a Docker container |
| `!docker start <name>` | Starts a Docker container |
| `!docker logs <name>` | Shows recent logs from a Docker container |
| `!nginx` | Shows if Nginx (web server) is running and if the config is valid |
| `!service <name> <action>` | Manage system services ⚠️ **Owner only** |

### Examples
```
!pm2 list               → Check all Node apps
!pm2 restart 1          → Restart PM2 process ID 1
!pm2 logs my-app        → View recent logs
!docker ps              → Check all containers
!docker restart mydb    → Restart a container
!nginx                  → Check web server health
!service nginx restart  → Restart nginx (owner only)
!service fail2ban start → Start fail2ban (owner only)
```

---

## ⚠️ Dangerous Commands (Owner Only)

These commands can **change your server**. Only the bot owner (ALERT_USER_ID) can run them, even if someone else has the `@sudo` role.

| Command | What It Does |
|---------|-------------|
| `!exec <command>` | Runs any Linux command on the server |
| `!sudo <command>` | Runs any command with admin (root) privileges |
| `!reboot` | Reboots the entire server (asks for confirmation first) |
| `!service <name> <action>` | Start/stop/restart system services |

### Safety Features
- 🚫 **Blocked commands:** `rm -rf /`, `mkfs`, `dd`, `shutdown`, `halt` are all blocked
- ⏱️ **Timeout:** Commands auto-cancel after 30 seconds
- ✅ **Confirmation:** `!reboot` requires you to type `yes` within 15 seconds

### Examples
```
!exec whoami            → Check which user the bot runs as
!exec free -h           → Check RAM usage in detail
!sudo cat /etc/hosts    → View the hosts file
!sudo systemctl status nginx → Check nginx service details
!reboot                 → Reboot (will ask "are you sure?")
```

---

## 🔒 Access Control

| Who | Can Run |
|-----|---------|
| Users with `@sudo` role | All normal commands |
| Bot owner (your user ID) | All commands including dangerous ones |
| Everyone else | Nothing |

The bot auto-creates the `@sudo` role on startup and assigns it to the owner. To give someone else access, just give them the `@sudo` role in Discord's server settings.

---

## 💡 Tips

- **Got an SSH warning?** Run `!explain` first to understand what's happening
- **See a suspicious IP?** Run `!whois <ip>` to find out who it is, then `!ban <ip>` to block them
- **App crashed?** Run `!pm2 list` or `!docker ps` to check, then `!pm2 restart <name>` to fix
- **Not sure what's wrong?** Run `!threats` — it only shows things that need attention
