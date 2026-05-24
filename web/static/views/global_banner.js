// MINIWEB-VIEW: global health and setup banner
(function () {
  "use strict";

  const { escapeHtml } = window.MiniwebFormat;

  function globalBannerState(deps = {}) {
    return deps.state || window.MiniwebState?.state || {};
  }

  function currentGameBotIds(deps = {}) {
    const state = globalBannerState(deps);
    return new Set(((state.settings && state.settings.game_bot_ids) || []).map((id) => Number(id)));
  }

  function updateGlobalBanner(deps = {}) {
    const banner = deps.globalBanner;
    if (!banner) return;
    const ids = currentGameBotIds(deps);
    const audit = globalBannerState(deps).messageAudit || {};
    if (audit.status && audit.status !== "ok") {
      const gapText = audit.gap_count ? `发现 ${audit.gap_count} 段近期断层` : "监听状态异常";
      banner.hidden = false;
      banner.innerHTML = `
        <span><strong>消息箱需要留意</strong> — ${escapeHtml(gapText)}，资源/副本统计可能受影响。</span>
        <button type="button" id="bannerOpenHealth">查看健康</button>
      `;
      banner.querySelector("#bannerOpenHealth")?.addEventListener("click", () => {
        Promise.resolve(deps.openHealthModal?.()).catch((error) => {
          console.warn("[mini-web] open health banner failed:", error);
        });
      });
      return;
    }
    if (ids.size === 0) {
      banner.hidden = false;
      banner.innerHTML = `
        <span><strong>未设置游戏 Bot</strong> — 现在系统消息(韩天尊)和玩家消息会混在一起,无法区分。</span>
        <button type="button" id="bannerOpenGameBots">去设置</button>
      `;
      banner.querySelector("#bannerOpenGameBots")?.addEventListener("click", () => {
        Promise.resolve(deps.openGameBotsModal?.()).catch((error) => {
          console.warn("[mini-web] open game-bots banner failed:", error);
        });
      });
      return;
    }
    banner.hidden = true;
    banner.innerHTML = "";
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.globalBanner = {
    currentGameBotIds,
    updateGlobalBanner,
  };
})();
