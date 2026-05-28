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
    POLL_INTERVAL_MS: 8000,  // 从 5s 改为 8s，减少轮询频率
    ACCOUNT_POLL_INTERVAL_MS: 45000,  // 从 30s 改为 45s
    BOT_DISCOVERY_POLL_INTERVAL_MS: 120000,  // 从 60s 改为 120s
    IDENTITY_STATE_POLL_INTERVAL_MS: 45000,  // 从 30s 改为 45s
    HEALTH_POLL_INTERVAL_MS: 90000,  // 从 60s 改为 90s
    WORLD_SNAPSHOT_POLL_INTERVAL_MS: 120000,  // 从 90s 改为 120s
  };
})();
