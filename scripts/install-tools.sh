#!/bin/bash
# ═══════════════════════════════════════════════════════════
#  install-tools.sh — Install security & monitoring tools
#  Run with: sudo bash scripts/install-tools.sh
# ═══════════════════════════════════════════════════════════

set -e

echo "══════════════════════════════════════════════════"
echo "  Ubuntu Server Monitor — Security Tools Installer"
echo "══════════════════════════════════════════════════"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "❌ Please run as root: sudo bash scripts/install-tools.sh"
  exit 1
fi

echo "📦 Updating package lists..."
export DEBIAN_FRONTEND=noninteractive
# Pre-seed Postfix config (pulled in by ClamAV) to skip interactive prompt
echo "postfix postfix/main_mailer_type select No configuration" | debconf-set-selections
apt-get update -qq

# ── lm-sensors (temperature monitoring) ──
echo ""
echo "🌡️  Installing lm-sensors..."
apt-get install -y -qq lm-sensors
sensors-detect --auto > /dev/null 2>&1 || true
echo "   ✅ lm-sensors installed"

# ── smartmontools (drive health) ──
echo ""
echo "💾 Installing smartmontools..."
apt-get install -y -qq smartmontools
echo "   ✅ smartmontools installed"

# ── fail2ban (brute force protection) ──
echo ""
echo "🚫 Installing fail2ban..."
apt-get install -y -qq fail2ban

# Create local config if it doesn't exist
if [ ! -f /etc/fail2ban/jail.local ]; then
  cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5
backend  = systemd

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
EOF
  echo "   📝 Created /etc/fail2ban/jail.local with SSH + nginx jails"
fi

systemctl enable fail2ban
systemctl restart fail2ban
echo "   ✅ fail2ban installed and enabled"

# ── ClamAV (antivirus) ──
echo ""
echo "🦠 Installing ClamAV..."
apt-get install -y -qq clamav clamav-daemon

# Stop freshclam daemon temporarily to update database
systemctl stop clamav-freshclam 2>/dev/null || true
freshclam --quiet 2>/dev/null || true
systemctl start clamav-freshclam 2>/dev/null || true

# Create log directory
mkdir -p /var/log/clamav
chown clamav:clamav /var/log/clamav

echo "   ✅ ClamAV installed (virus definitions updating)"

# ── rkhunter (rootkit detection) ──
echo ""
echo "🔍 Installing rkhunter..."
apt-get install -y -qq rkhunter

# Update rkhunter database
rkhunter --update --quiet 2>/dev/null || true
rkhunter --propupd --quiet 2>/dev/null || true

echo "   ✅ rkhunter installed"

# ── auditd (system auditing) ──
echo ""
echo "📋 Installing auditd..."
apt-get install -y -qq auditd

# Add basic audit rules for critical files
if ! grep -q "/etc/passwd" /etc/audit/rules.d/audit.rules 2>/dev/null; then
  cat >> /etc/audit/rules.d/audit.rules <<'EOF'

# Monitor critical files
-w /etc/passwd -p wa -k passwd_changes
-w /etc/shadow -p wa -k shadow_changes
-w /etc/sudoers -p wa -k sudoers_changes
-w /etc/ssh/sshd_config -p wa -k sshd_config
EOF
  echo "   📝 Added audit rules for critical file monitoring"
fi

systemctl enable auditd
systemctl restart auditd
echo "   ✅ auditd installed and enabled"

# ── Summary ──
echo ""
echo "══════════════════════════════════════════════════"
echo "  ✅ All security tools installed successfully!"
echo ""
echo "  Installed:"
echo "    • lm-sensors    — CPU/hardware temperature"
echo "    • smartmontools — Drive health & temperature"
echo "    • fail2ban      — Brute force protection"
echo "    • ClamAV        — Antivirus scanning"
echo "    • rkhunter      — Rootkit detection"
echo "    • auditd        — System call auditing"
echo ""
echo "  Next: Run  sudo bash scripts/setup-permissions.sh"
echo "══════════════════════════════════════════════════"
