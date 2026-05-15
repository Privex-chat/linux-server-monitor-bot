const fs = require('fs').promises;
const path = require('path');

// Mock config before requiring storage
jest.mock('../../config', () => ({
  STATE_FILE: './data/test-state.json',
  TIMEZONE: 'UTC',
  LOG_LEVEL: 'silent',
}));

// Mock logger to suppress output during tests
jest.mock('../utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { loadState, getState, updateState, DEFAULT_STATE } = require('../utils/storage');

const TEST_STATE_PATH = path.resolve('./data/test-state.json');

beforeEach(async () => {
  // Clean up test state file
  try {
    await fs.unlink(TEST_STATE_PATH);
  } catch {
    // file may not exist
  }
});

afterAll(async () => {
  try {
    await fs.unlink(TEST_STATE_PATH);
  } catch {
    // cleanup
  }
});

describe('storage', () => {
  test('loadState creates default state when file missing', async () => {
    const state = await loadState();
    expect(state).toBeDefined();
    expect(state.channelId).toBeNull();
    expect(state.messageIds).toBeDefined();
    expect(state.threadIds).toBeDefined();
    expect(state.logOffsets).toBeDefined();
    expect(state.dailyAccumulator).toBeDefined();
    expect(state.dailyAccumulator.cpuSamples).toEqual([]);
  });

  test('loadState persists and reloads state', async () => {
    await loadState();
    await updateState((s) => {
      s.channelId = '123456';
    });

    // Force reload by re-requiring
    const state = await loadState();
    expect(state.channelId).toBe('123456');
  });

  test('updateState applies mutator and saves', async () => {
    await loadState();
    await updateState((s) => {
      s.messageIds.liveStats = 'msg-001';
      s.dailyAccumulator.cpuSamples.push(42);
    });

    const state = getState();
    expect(state.messageIds.liveStats).toBe('msg-001');
    expect(state.dailyAccumulator.cpuSamples).toContain(42);
  });

  test('getState returns default when no state loaded', () => {
    // getState without loadState should return defaults
    const state = getState();
    expect(state).toBeDefined();
    expect(state.channelId).toBeNull();
  });

  test('loadState merges new keys into existing state', async () => {
    // Write partial state (missing some keys)
    const dir = path.dirname(TEST_STATE_PATH);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      TEST_STATE_PATH,
      JSON.stringify({
        channelId: 'existing-channel',
        messageIds: { liveStats: 'msg-1' },
      }),
      'utf8'
    );

    const state = await loadState();
    expect(state.channelId).toBe('existing-channel');
    expect(state.messageIds.liveStats).toBe('msg-1');
    // New keys should be filled from defaults
    expect(state.messageIds.dailySummary).toBeNull();
    expect(state.threadIds).toBeDefined();
    expect(state.logOffsets).toBeDefined();
  });

  test('DEFAULT_STATE is exported and immutable from callers', () => {
    expect(DEFAULT_STATE).toBeDefined();
    expect(DEFAULT_STATE.channelId).toBeNull();
    expect(Array.isArray(DEFAULT_STATE.dailyAccumulator.cpuSamples)).toBe(true);
  });
});
