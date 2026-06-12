// MINIWEB-MODULE: shared frontend constants
(function () {
  "use strict";

  window.MiniwebConstants = {
    MESSAGE_PREVIEW_CHAR_LIMIT: 480,
    MESSAGE_PREVIEW_LINE_LIMIT: 8,
    CHANNEL_SUMMARY_LIMIT: 160,
    NUMERIC_SOURCE_RE: /^-?\d{4,}$/,
    EMOJI_PALETTE: [
      "😀", "😂", "🤣", "😅", "🥹", "😎", "🙃", "😭",
      "👍", "🙏", "👌", "👏", "🤝", "👀", "💤", "💢",
      "🔥", "✨", "⚔️", "🧘‍♂️", "🍃", "💧", "🌙", "🎉",
      "⚠️", "🚫", "✅", "❌", "❓", "💰", "📦", "🧩",
    ],
    POLL_INTERVAL_MS: 12000,
    ACCOUNT_POLL_INTERVAL_MS: 60000,
    BOT_DISCOVERY_POLL_INTERVAL_MS: 600000,
    IDENTITY_STATE_POLL_INTERVAL_MS: 60000,
    HEALTH_POLL_INTERVAL_MS: 600000,
    WORLD_SNAPSHOT_POLL_INTERVAL_MS: 600000,
  };
})();
