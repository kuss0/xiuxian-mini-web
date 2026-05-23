// MINIWEB-VIEW: game bot settings modal
(function () {
  "use strict";

  const { closeModal, openModal } = window.MiniwebModal;
  const { escapeAttr, escapeHtml } = window.MiniwebFormat;

  function openGameBotsModal({
    discoveredBots = [],
    loadDiscoveredBots,
    saveGameBotIds,
    settings = {},
  }) {
    const currentList = (settings.game_bot_ids || []).map((x) => String(x));
    const dialog = openModal({
      title: "游戏 Bot 设置(谁是系统/韩天尊)",
      body: `
        <section class="modal-section">
          <h4>当前的游戏 Bot sender 列表</h4>
          <p class="muted">这些 sender 发出来的消息,chat UI 会标记成「系统消息」,跟玩家消息分开。多个 ID 用 <strong>逗号</strong> 分隔。负数 -100… 是频道身份,正数是 bot/用户。</p>
          <textarea class="game-bot-modal-input" id="gameBotsInput" rows="3" placeholder="-1003983937918, 7900199668, ...">${escapeHtml(currentList.join(", "))}</textarea>
        </section>

        <section class="modal-section">
          <h4>从消息箱里发现的可能 sender(辅助)</h4>
          <p class="muted">这些是消息箱里 bot 类型 / 频道号 sender,而且真的发过包含游戏关键词(点卯/天梯/灵树/侍妾...)的消息。普通玩家闲聊不会被丢进来。点「+」加进上面输入框。</p>
          <div id="gameBotsDiscoveredList" class="game-bot-discovered-list">
            <p class="empty">还没在消息箱里发现「游戏 bot 风格」的发言。先开始采集,或在上面手动填 sender_id。</p>
          </div>
        </section>

        <p class="modal-status-line info" id="gameBotsStatus" hidden></p>
      `,
      footer: `
        <button type="button" data-modal-close>取消</button>
        <button type="button" class="primary" id="gameBotsSaveBtn">保存</button>
      `,
    });
    if (!dialog) return;

    const local = { discoveredBots: discoveredBots || [] };
    bindGameBotsModal(dialog, local, { saveGameBotIds });
    renderDiscoveredList(dialog, local.discoveredBots);

    loadDiscoveredBots()
      .then((items) => {
        local.discoveredBots = items || [];
        renderDiscoveredList(dialog, local.discoveredBots);
      })
      .catch((error) => console.warn("[mini-web] discovered-bots fetch failed:", error));
  }

  function renderDiscoveredList(dialog, items) {
    const list = dialog.querySelector("#gameBotsDiscoveredList");
    const input = dialog.querySelector("#gameBotsInput");
    if (!list || !input) return;
    if (!items.length) {
      list.innerHTML = '<p class="empty">还没在消息箱里发现「游戏 bot 风格」的发言(参考关键词命中)。让 listener 多采集一会儿,或者直接在上面手动填 sender_id。</p>';
      return;
    }
    const inText = (id) => {
      const tokens = (input.value || "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
      return tokens.includes(String(id));
    };
    list.innerHTML = items.map((bot) => {
      const id = String(bot.sender_id);
      const inList = inText(id);
      const kindLabel = bot.kind === "channel" ? "频道" : "bot";
      const families = Array.isArray(bot.matched_families) ? bot.matched_families : [];
      let meta;
      if (bot.manual_only) {
        meta = "手动添加,消息箱里还没采到过这个 sender 的游戏消息";
      } else {
        const familyText = families.length ? `命中 ${families.slice(0, 4).join("/")}${families.length > 4 ? "…" : ""}` : "暂无命中";
        meta = `${kindLabel}｜${bot.hit_count || 0}/${bot.message_count} 条命中｜${familyText}｜sender ${id}`;
      }
      return `
        <div class="game-bot-discovered-row${inList ? " in-list" : ""}" data-bot-row="${escapeAttr(id)}">
          <div class="info">
            <strong>${escapeHtml(bot.last_source || "(未知名)")}</strong>
            <small>${escapeHtml(meta)}</small>
          </div>
          <button type="button" data-bot-add="${escapeAttr(id)}" ${inList ? "disabled" : ""}>${inList ? "已加入" : "+ 加入"}</button>
        </div>
      `;
    }).join("");
    list.querySelectorAll("[data-bot-add]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.botAdd;
        const tokens = (input.value || "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        if (!tokens.includes(id)) tokens.push(id);
        input.value = tokens.join(", ");
        renderDiscoveredList(dialog, items);
      });
    });
  }

  function bindGameBotsModal(dialog, local, { saveGameBotIds }) {
    const input = dialog.querySelector("#gameBotsInput");
    const saveBtn = dialog.querySelector("#gameBotsSaveBtn");
    const status = dialog.querySelector("#gameBotsStatus");
    if (input) {
      input.addEventListener("input", () => renderDiscoveredList(dialog, local.discoveredBots || []));
    }
    if (!saveBtn) return;
    saveBtn.addEventListener("click", async () => {
      const parsed = parseSenderIds(input?.value || "");
      if (parsed.bad.length) {
        setStatus(status, "error", `不合法的 ID:${parsed.bad.join(", ")} (要非零整数)`);
        return;
      }
      saveBtn.disabled = true;
      setStatus(status, "info", "正在保存…");
      try {
        await saveGameBotIds(parsed.ids);
        setStatus(status, "ok", `已保存 ${parsed.ids.length} 条游戏 Bot ID`);
        window.setTimeout(() => closeModal(), 600);
      } catch (error) {
        setStatus(status, "error", error.message || "保存失败");
        saveBtn.disabled = false;
      }
    });
  }

  function parseSenderIds(value) {
    const tokens = String(value || "").replace(/，/g, ",").split(",").map((s) => s.trim()).filter(Boolean);
    const ids = [];
    const bad = [];
    const seen = new Set();
    for (const token of tokens) {
      const n = Number(token);
      if (!Number.isFinite(n) || n === 0) {
        bad.push(token);
        continue;
      }
      if (seen.has(n)) continue;
      seen.add(n);
      ids.push(n);
    }
    return { ids: ids.sort((a, b) => a - b), bad };
  }

  function setStatus(status, kind, text) {
    if (!status) return;
    status.hidden = !text;
    status.className = `modal-status-line ${kind}`;
    status.textContent = text || "";
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.gameBots = { openGameBotsModal };
})();
