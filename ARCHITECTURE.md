# Architecture

## Overview

The bot follows a **collector-task-formatter** pattern:

- **Collectors** gather raw data from the system (pure functions, no side effects)
- **Tasks** run on schedules, call collectors, and update Discord
- **Formatters** transform data into Discord embeds

```
Discord ←→ index.js (scheduler + command router)
              │
              ├── src/commands.js        ← Command handler + registry
              ├── src/setup.js           ← Channel/thread/role initialization
              │
              ├── src/collectors/        ← Pure data gathering
              │   ├── system.js          ← CPU, RAM, disk, network, uptime
              │   ├── temperature.js     ← lm-sensors + smartctl
              │   ├── power.js           ← Intel RAPL energy counters
              │   ├── pm2.js             ← PM2 process list (JSON)
              │   ├── docker.js          ← Docker container stats
              │   ├── security.js        ← Auth logs, fail2ban, UFW, rootkit, AV
              │   └── nginx.js           ← Access/error log pattern matching
              │
              ├── src/tasks/             ← Scheduled update loops
              │   ├── liveStats.js       ← Every 12-15s: system + temps + power
              │   ├── securityStatus.js  ← Every 5m: security collector → alerts
              │   ├── summaries.js       ← Daily/weekly cron: aggregate stats
              │   ├── securityScan.js    ← Daily cron: rkhunter + ClamAV
              │   └── logWatcher.js      ← Every 30s: tail logs → post to threads
              │
              ├── src/formatters/
              │   └── embeds.js          ← Discord EmbedBuilder helpers
              │
              └── src/utils/
                  ├── exec.js            ← Safe command execution (execFile)
                  ├── storage.js         ← JSON state persistence
                  └── logger.js          ← Timestamped console logger
```

## Boot Sequence

1. **Validate config** — checks required env vars, exits if missing
2. **Create Discord client** — enables Guilds, GuildMessages, MessageContent intents
3. **On ready:**
   - Load persisted state from `data/state.json`
   - Fetch guild, validate bot is invited
   - `ensureSetup()` creates/verifies channel, placeholder messages, log threads, @sudo role
   - Initialize all task modules with shared resources
   - Run initial data collection (2 passes, 3s apart for RAPL baseline)
   - Start schedulers (intervals, cron jobs, recursive setTimeout)
4. **Register message handler** — routes `!commands` to command dispatcher

## Data Flow

### Live Stats (every 12-15s)

```
/proc/stat, /proc/net/dev, free, df, sensors, RAPL
    → collectors return structured objects
    → embeds.js builds Discord embeds
    → edit existing placeholder messages in channel
    → accumulate samples in state for daily summary
```

### Log Watcher (every 30s)

```
tail log files from stored byte offset
    → filter noise (CRON, session opens, bot's own commands)
    → deduplicate (count repeats, show [×N])
    → categorize by log type
    → post to appropriate thread (logs-auth, logs-system, etc.)
    → update byte offset in state
```

### Security Alerts

```
security collector runs every 5 minutes
    → scores findings (0=SECURE, 1=ADVISORY, 2=WARNING, 3=CRITICAL)
    → if WARNING+: post to logs-security thread with user mention
    → edit security status embed with current threat level
```

## State Management

`data/state.json` persists across restarts:

- `channelId`, `messageIds`, `threadIds` — Discord resource IDs
- `sudoRoleId` — role used for access control
- `logOffsets` — byte positions for incremental log reading
- `dailyAccumulator` — samples for daily summary (capped at 1500)
- `weeklyAccumulator` — daily snapshots for weekly summary

The `updateState(fn)` pattern reads, applies a mutation function, then writes atomically.

## Command Execution Safety

Commands use `safeExec()` which wraps Node's `execFile` (not `exec`) for array arguments, preventing shell metacharacter injection. Additional layers:

1. **Access control**: `@sudo` role required, dangerous commands require owner
2. **Rate limiting**: per-user cooldown map (3s default, 30s dangerous)
3. **Blocklist**: 25 patterns block destructive commands
4. **Confirmation**: `!exec` and `!sudo` require typing `yes` within 15s
5. **Timeouts**: all commands have execution timeouts
6. **Input validation**: service/process names validated against `[a-zA-Z0-9._-]`
7. **Error sanitization**: file paths, IPs, tokens stripped from error messages
8. **Audit logging**: dangerous commands logged to Discord security thread

## Adding a New Collector

1. Create `src/collectors/myfeature.js` exporting async functions
2. Use `safeExec()` for all system commands
3. Return structured data (no Discord formatting)
4. Handle failures gracefully (return defaults, not exceptions)
5. Call it from the appropriate task in `src/tasks/`
6. Add embed builder in `src/formatters/embeds.js` if needed

## Adding a New Command

1. In `src/commands.js`, call `registerCommand('name', { ... })`
2. Set `category`, `description`, `usage`
3. Set `dangerous: true` if it modifies the system
4. Set `cooldown: config.COOLDOWN_*_MS` for rate limiting
5. Validate all user input before passing to `safeExec()`
6. Use `config.MAX_DISCORD_MSG_LENGTH` for output truncation
