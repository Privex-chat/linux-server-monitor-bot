#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  setup-permissions.sh — Set up permissions for monitoring
#  Run with: sudo bash scripts/setup-permissions.sh
# ═══════════════════════════════════════════════════════════

set -e

BOT_USER="${1:-sonix}"

echo "══════════════════════════════════════════════════"
echo "  Ubuntu Server Monitor — Permissions Setup"
echo "  Bot user: $BOT_USER"
echo "══════════════════════════════════════════════════"
echo ""

if [ "$EUID" -ne 0 ]; then
  echo "❌ Please run as root: sudo bash scripts/setup-permissions.sh [username]"
  exit 1
fi

# ── 1. RAPL power monitoring (Intel) ──
echo "⚡ Setting up RAPL power monitoring..."
if [ -d /sys/class/powercap/intel-rapl ]; then
  chmod -R a+r /sys/class/powercap/intel-rapl/

  # Persistent udev rule
  UDEV_RULE='/etc/udev/rules.d/99-powercap.rules'
  if [ ! -f "$UDEV_RULE" ]; then
    echo 'SUBSYSTEM=="powercap", ACTION=="add", RUN+="/bin/chmod -R a+r /sys/class/powercap/"' > "$UDEV_RULE"
    udevadm control --reload-rules
    udevadm trigger
    echo "   ✅ RAPL permissions set + udev rule created"
  else
    echo "   ✅ RAPL udev rule already exists"
  fi
else
  echo "   ⚠️  RAPL not found. Intel power monitoring won't be available."
fi

# ── 2. Docker group ──
echo ""
echo "🐳 Adding $BOT_USER to docker group..."
if getent group docker > /dev/null 2>&1; then
  usermod -aG docker "$BOT_USER"
  echo "   ✅ $BOT_USER added to docker group"
  echo "   ℹ️  Log out and back in for group change to take effect"
else
  echo "   ⚠️  docker group doesn't exist. Is Docker installed?"
fi

# ── 3. Sudoers for monitoring commands (passwordless) ──
echo ""
echo "🔐 Setting up passwordless sudo for monitoring commands..."
SUDOERS_FILE="/etc/sudoers.d/server-monitor"
cat > "$SUDOERS_FILE" <<EOF
# Server Monitor Bot — passwordless sudo for read-only monitoring commands
$BOT_USER ALL=(ALL) NOPASSWD: /usr/bin/tail -c * /var/log/auth.log
$BOT_USER ALL=(ALL) NOPASSWD: /usr/bin/tail -c * /var/log/syslog
$BOT_USER ALL=(ALL) NOPASSWD: /usr/bin/tail -c * /var/log/ufw.log
$BOT_USER ALL=(ALL) NOPASSWD: /usr/bin/tail -* /var/log/nginx/*
$BOT_USER ALL=(ALL) NOPASSWD: /usr/bin/tail -* /var/log/rkhunter.log
$BOT_USER ALL=(ALL) NOPASSWD: /usr/bin/tail -* /var/log/clamav/*
$BOT_USER ALL=(ALL) NOPASSWD: /usr/sbin/ufw status *
$BOT_USER ALL=(ALL) NOPASSWD: /usr/bin/fail2ban-client status *
$BOT_USER ALL=(ALL) NOPASSWD: /usr/bin/fail2ban-client status
$BOT_USER ALL=(ALL) NOPASSWD: /usr/sbin/smartctl *
$BOT_USER ALL=(ALL) NOPASSWD: /usr/sbin/hddtemp *
$BOT_USER ALL=(ALL) NOPASSWD: /usr/bin/rkhunter --check *
$BOT_USER ALL=(ALL) NOPASSWD: /usr/bin/last *
$BOT_USER ALL=(ALL) NOPASSWD: /usr/bin/lastb *
$BOT_USER ALL=(ALL) NOPASSWD: /usr/bin/grep * /var/log/auth.log
$BOT_USER ALL=(ALL) NOPASSWD: /usr/bin/ls -la /proc/*/exe
$BOT_USER ALL=(ALL) NOPASSWD: /usr/sbin/nvme *
EOF

chmod 440 "$SUDOERS_FILE"
visudo -c -f "$SUDOERS_FILE" 2>/dev/null
if [ $? -eq 0 ]; then
  echo "   ✅ Sudoers rules created at $SUDOERS_FILE"
else
  echo "   ❌ Sudoers syntax error! Removing file."
  rm -f "$SUDOERS_FILE"
  exit 1
fi

# ── 4. Log file read permissions ──
echo ""
echo "📋 Setting log file permissions..."

# Ensure the bot user can read essential logs via the sudoers rules above
# (we don't chmod the logs directly — sudoers handles it)
echo "   ✅ Log access configured via sudoers (no direct chmod needed)"

# ── 5. Ensure data directory exists ──
echo ""
echo "📁 Creating bot data directory..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_DIR="$(dirname "$SCRIPT_DIR")"
mkdir -p "$BOT_DIR/data"
chown -R "$BOT_USER:$BOT_USER" "$BOT_DIR/data"
echo "   ✅ data/ directory ready"

# ── Summary ──
echo ""
echo "══════════════════════════════════════════════════"
echo "  ✅ Permissions setup complete!"
echo ""
echo "  Configured:"
echo "    • RAPL power monitoring (Intel)"
echo "    • Docker group membership"
echo "    • Passwordless sudo for monitoring commands"
echo "    • Bot data directory"
echo ""
echo "  ⚠️  IMPORTANT: Log out and back in as '$BOT_USER'"
echo "     for docker group changes to take effect."
echo ""
echo "  Next steps:"
echo "    1. cd $BOT_DIR"
echo "    2. cp .env.example .env"
echo "    3. Edit .env with your Discord bot token"
echo "    4. npm install"
echo "    5. pm2 start ecosystem.config.js"
echo "    6. pm2 save && pm2 startup"
echo "══════════════════════════════════════════════════"
