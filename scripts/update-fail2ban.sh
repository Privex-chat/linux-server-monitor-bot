#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  update-fail2ban.sh — Update fail2ban to ignore LAN & use UFW
#  Run with: sudo bash scripts/update-fail2ban.sh
# ═══════════════════════════════════════════════════════════

set -e

if [ "$EUID" -ne 0 ]; then
  echo "❌ Please run as root: sudo bash scripts/update-fail2ban.sh"
  exit 1
fi

echo "🚫 Updating /etc/fail2ban/jail.local..."

cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
# Ignore localhost and all private LAN IPs (IPv4 and IPv6)
ignoreip = 127.0.0.1/8 ::1 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16
# Ban for 1 hour
bantime  = 1h
# Within a 10 minute window
findtime = 10m
# If they fail 5 times
maxretry = 5
backend  = systemd
# Use UFW for banning (supports IPv4 and IPv6 natively)
banaction = ufw

[sshd]
enabled = true
port    = ssh
logpath = /var/log/auth.log
maxretry = 5

[nginx-http-auth]
enabled  = true
port     = http,https
logpath  = /var/log/nginx/error.log
maxretry = 5

[nginx-botsearch]
enabled  = true
port     = http,https
logpath  = /var/log/nginx/access.log
maxretry = 5

# Ban repeat offenders for a whole week
[recidive]
enabled  = true
logpath  = /var/log/fail2ban.log
banaction = ufw
bantime  = 1w
findtime = 1d
maxretry = 3
EOF

systemctl restart fail2ban
echo "✅ fail2ban configuration updated and restarted!"
echo "   - LAN IPs are now ignored"
echo "   - IPv4 and IPv6 support enforced via UFW"
echo "   - Repeat offenders will be banned for 1 week"
