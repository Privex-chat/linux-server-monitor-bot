# Contributing

Thanks for your interest in contributing! This guide covers everything you need to get started.

## Development Setup

### Prerequisites

- Node.js 18+
- A Discord bot token ([create one here](https://discord.com/developers/applications))
- A Linux server (or VM) for testing — the bot reads from `/proc`, `/var/log`, etc.

### Getting Started

```bash
git clone https://github.com/YOUR_USERNAME/linux-server-monitor-bot.git
cd linux-server-monitor-bot
npm install

# Set up environment
cp .env.example .env
# Edit .env with your Discord token, guild ID, and user ID

# Install security tools on your Linux server
sudo bash scripts/install-tools.sh
sudo bash scripts/setup-permissions.sh $USER

# Run in development mode (auto-restart on file changes)
npm run dev
```

### Code Quality

```bash
npm run lint        # Check for issues
npm run lint:fix    # Auto-fix what's possible
npm run format      # Format with Prettier
npm run check       # Lint + format check (CI-ready)
```

## Project Structure

See [ARCHITECTURE.md](ARCHITECTURE.md) for a detailed breakdown. Key directories:

- `src/collectors/` — Pure data-gathering functions (no side effects)
- `src/tasks/` — Scheduled loops that call collectors and update Discord
- `src/commands.js` — Command registry and handler
- `src/formatters/embeds.js` — Discord embed builders
- `src/utils/` — Shared utilities (exec, storage, logger)

## How to Contribute

### Bug Reports

Open an issue with:

- What you expected vs. what happened
- Your OS and Node.js version
- Relevant log output (redact IPs and tokens)

### Feature Requests

Open an issue describing:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you considered

### Pull Requests

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm run check` — ensure no lint or format errors
4. Test on a real Linux system if your change touches collectors or commands
5. Open a PR with a clear description of what and why

### Adding a New Command

See the "Adding a New Command" section in [ARCHITECTURE.md](ARCHITECTURE.md).

### Adding Support for a New Distro

The bot currently targets Debian/Ubuntu. To add support for another distro:

1. Check which commands differ (e.g., `apt` vs `dnf`, `journalctl` vs `/var/log/syslog`)
2. Add distro detection in the relevant collector
3. Test on the target distro
4. Document any additional setup steps in the README

## Guidelines

- **Keep dependencies minimal.** The bot currently has only 3 runtime deps. Don't add a package for something achievable in a few lines of code.
- **Collectors must be pure.** They gather data and return it — no Discord API calls, no side effects.
- **Validate all user input.** Anything from Discord commands must be sanitized before reaching `safeExec()`.
- **Handle failures gracefully.** Missing tools (sensors, docker, pm2) should result in "N/A", not crashes.
- **Test on real hardware.** Mocking system commands hides real issues. Test on an actual Linux box.
- **No false positives.** If you add a detection pattern, make sure it won't trigger on legitimate processes or traffic.

## Code Style

- Single quotes, trailing commas, 2-space indent (enforced by Prettier)
- `const` by default, `let` when reassignment is needed, never `var`
- Strict equality (`===`) always
- Minimal comments — only explain non-obvious _why_, not _what_

## Security

If you discover a security vulnerability, please report it privately rather than opening a public issue. Contact the maintainers directly.
