const config = require('../../config');

const SEVERITY_RANK = {
  SECURE: 0,
  ADVISORY: 1,
  WARNING: 2,
  CRITICAL: 3,
};

function ensureSecurityState(state) {
  if (!state.security) {
    state.security = {};
  }
  state.security.recentSshFailures = Array.isArray(state.security.recentSshFailures)
    ? state.security.recentSshFailures
    : [];
  state.security.recentUfwBlocks = Array.isArray(state.security.recentUfwBlocks) ? state.security.recentUfwBlocks : [];
  state.security.recentNginxAttacks = Array.isArray(state.security.recentNginxAttacks)
    ? state.security.recentNginxAttacks
    : [];
  state.security.alertCache = state.security.alertCache || {};
  return state.security;
}

function normalizeEvent(event, now = Date.now()) {
  if (typeof event === 'string') {
    return { ts: now, value: event };
  }
  return {
    ts: Number.isFinite(event.ts) ? event.ts : now,
    ...event,
  };
}

function pruneEvents(events, retentionMs = config.SECURITY_EVENT_RETENTION_MS, now = Date.now()) {
  const cutoff = now - retentionMs;
  return (events || [])
    .map((event) => normalizeEvent(event, now))
    .filter((event) => Number.isFinite(event.ts) && event.ts >= cutoff)
    .slice(-5000);
}

function addSecurityEvents(state, key, events, now = Date.now()) {
  if (!events || events.length === 0) return;

  const security = ensureSecurityState(state);
  const current = pruneEvents(security[key], config.SECURITY_EVENT_RETENTION_MS, now);
  const next = events.map((event) => normalizeEvent(event, now));
  security[key] = pruneEvents([...current, ...next], config.SECURITY_EVENT_RETENTION_MS, now);
}

function summarizeEvents(events, windowMs, now = Date.now(), groupKey = 'ip') {
  const cutoff = now - windowMs;
  const recent = pruneEvents(events, windowMs, now).filter((event) => event.ts >= cutoff);
  const counts = new Map();

  for (const event of recent) {
    const key = event[groupKey] || 'unknown';
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([value, count]) => ({ value, count }));

  return {
    count: recent.length,
    unique: counts.size,
    top,
    events: recent,
  };
}

function shouldSendAlert(
  state,
  key,
  fingerprint,
  level,
  cooldownMs = config.SECURITY_ALERT_COOLDOWN_MS,
  now = Date.now()
) {
  const security = ensureSecurityState(state);
  const cached = security.alertCache[key];
  if (!cached) return true;

  const cooldownElapsed = now - (cached.sentAt || 0) >= cooldownMs;
  const severityIncreased = (SEVERITY_RANK[level] || 0) > (SEVERITY_RANK[cached.level] || 0);

  if (severityIncreased) return true;
  if (cached.fingerprint !== fingerprint && cooldownElapsed) return true;
  if (cooldownElapsed && level === 'CRITICAL') return true;

  return false;
}

function markAlertSent(state, key, fingerprint, level, now = Date.now()) {
  const security = ensureSecurityState(state);
  security.alertCache[key] = { fingerprint, level, sentAt: now };
}

function clearAlert(state, key) {
  const security = ensureSecurityState(state);
  delete security.alertCache[key];
}

module.exports = {
  SEVERITY_RANK,
  ensureSecurityState,
  pruneEvents,
  addSecurityEvents,
  summarizeEvents,
  shouldSendAlert,
  markAlertSent,
  clearAlert,
};
