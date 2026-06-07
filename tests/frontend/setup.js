// Jest setup file
import '@testing-library/jest-dom';

// Mock window.MiniwebState
global.window.MiniwebState = {
  state: {
    messages: [],
    channels: [],
    selectedChannels: new Set(),
    selectedMessageId: null,
    detailMode: 'message',
    viewMode: 'all',
  }
};

// Mock window.MiniwebConstants
global.window.MiniwebConstants = {
  POLL_INTERVAL_MS: 12000,
  ACCOUNT_POLL_INTERVAL_MS: 60000,
  BOT_DISCOVERY_POLL_INTERVAL_MS: 180000,
  HEALTH_POLL_INTERVAL_MS: 120000,
  IDENTITY_STATE_POLL_INTERVAL_MS: 60000,
  WORLD_SNAPSHOT_POLL_INTERVAL_MS: 180000,
  CHANNEL_SUMMARY_LIMIT: 160,
  MESSAGE_PREVIEW_CHAR_LIMIT: 180,
  MESSAGE_PREVIEW_LINE_LIMIT: 3,
  EMOJI_PALETTE: ['👍', '❤️', '😊', '🎉', '🔥'],
  NUMERIC_SOURCE_RE: /^\d+$/,
};

// Mock window.MiniwebApi
global.window.MiniwebApi = {
  apiFetch: jest.fn(),
  fetchJson: jest.fn(),
  postJson: jest.fn(),
};

// Mock window.MiniwebFormat
global.window.MiniwebFormat = {
  escapeHtml: (str) => String(str || '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;'
  })[m]),
  escapeAttr: (str) => String(str || '').replace(/["']/g, (m) => m === '"' ? '&quot;' : '&#x27;'),
  clipGraphemes: (str, limit) => String(str || '').slice(0, limit),
  countGraphemes: (str) => String(str || '').length,
  firstGrapheme: (str) => String(str || '')[0] || '',
  formatNumber: (num) => Number(num || 0).toLocaleString(),
};

// Mock console methods to reduce noise
global.console = {
  ...console,
  log: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
