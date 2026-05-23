// MINIWEB-MODULE: shared frontend constants
(function () {
  "use strict";

  window.MiniwebConstants = {
    MESSAGE_PREVIEW_CHAR_LIMIT: 480,
    MESSAGE_PREVIEW_LINE_LIMIT: 8,
    CHANNEL_SUMMARY_LIMIT: 260,
    NUMERIC_SOURCE_RE: /^-?\d{4,}$/,
    EMOJI_PALETTE: [
      "😀", "😂", "🤣", "😅", "🥹", "😎", "🙃", "😭",
      "👍", "🙏", "👌", "👏", "🤝", "👀", "💤", "💢",
      "🔥", "✨", "⚔️", "🧘‍♂️", "🍃", "💧", "🌙", "🎉",
      "⚠️", "🚫", "✅", "❌", "❓", "💰", "📦", "🧩",
    ],
    POLL_INTERVAL_MS: 5000,
    ACCOUNT_POLL_INTERVAL_MS: 30000,
    BOT_DISCOVERY_POLL_INTERVAL_MS: 60000,
    IDENTITY_STATE_POLL_INTERVAL_MS: 30000,
    HEALTH_POLL_INTERVAL_MS: 60000,
    WORLD_SNAPSHOT_POLL_INTERVAL_MS: 90000,
  };
})();
