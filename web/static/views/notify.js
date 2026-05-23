// MINIWEB-VIEW: notification settings modal
(function () {
  "use strict";

  const { fetchJson, postJson } = window.MiniwebApi;
  const { closeModal, openModal } = window.MiniwebModal;
  const { escapeAttr, escapeHtml } = window.MiniwebFormat;

  async function openNotifySettingsModal({ loadSettings }) {
    const settings = await loadSettings();
    const savedSecrets = settings.saved_secrets || {};
    const enabled = !!settings.notify_enabled;
    const subscribed = new Set(settings.notify_card_titles || []);

    const dialog = openModal({
      title: "通知设置",
      body: `
        <section class="modal-section">
          <h4>通道:Telegram Bot</h4>
          <p class="muted">用一个独立的 Telegram bot(BotFather 申请),把关键事件推到指定 chat。Bot 需要先被你加进 chat 一次(私聊就 /start 一下,群里把 bot 拉进去)。</p>

          <label class="notify-toggle">
            <input type="checkbox" id="notifyEnabled" ${enabled ? "checked" : ""} />
            <span>启用通知</span>
          </label>

          <div class="form-grid" style="margin-top:8px;">
            <label>
              <span>Bot Token</span>
              <input id="notifyTgBotToken" type="text" value=""
                placeholder="${savedSecrets.notify_tg_bot_token ? "已保存,留空不变;重新填写则覆盖" : "BotFather 给的 token,形如 1234567:ABC..."}"
                autocomplete="off" />
            </label>
            <label>
              <span>Chat ID</span>
              <input id="notifyTgChatId" type="text" value="${escapeAttr(settings.notify_tg_chat_id || "")}"
                placeholder="私聊 = 你的 user_id;群 = -100xxx" />
            </label>
          </div>
        </section>

        <section class="modal-section">
          <h4>订阅哪些事件</h4>
          <p class="muted">命中订阅清单的卡片才会推。同一条消息 60s 内不会重复推(防 NewMessage+Edit 双触发)。</p>
          <div id="notifyEventGrid" class="notify-event-grid">
            <p class="muted">加载中...</p>
          </div>
        </section>

        <p class="modal-status-line info" id="notifyStatus" hidden></p>
      `,
      footer: `
        <button type="button" data-modal-close>关闭</button>
        <button type="button" id="notifyTestBtn">发测试通知</button>
        <button type="button" class="primary" id="notifySaveBtn">保存</button>
      `,
    });
    if (!dialog) return;

    await renderNotifyCardTitleOptions(dialog, subscribed);
    bindNotifySettingsModal(dialog, { loadSettings });
  }

  async function renderNotifyCardTitleOptions(dialog, subscribed) {
    const grid = dialog.querySelector("#notifyEventGrid");
    if (!grid) return;
    try {
      const data = await fetchJson("/api/notify/card-titles");
      const titles = data.titles || [];
      const groups = [
        { name: "高危", keys: ["风险提醒", "天道审判"] },
        { name: "prompt", keys: ["玄骨考校", "天机考验", "极阴祖师", "南陇侯", "共历心劫", "第二元神归位"] },
        { name: "里程碑", keys: ["境界突破", "赐予道号", "试炼古塔战报", "深度闭关总结", "闭关成功"] },
        { name: "副本/物品", keys: ["虚天殿开启", "加入副本成功", "加入副本失败", "副本房间解散", "储物袋快照", "灵树采摘"] },
      ];
      const used = new Set();
      let html = "";
      for (const group of groups) {
        const present = group.keys.filter((key) => titles.includes(key));
        if (!present.length) continue;
        present.forEach((key) => used.add(key));
        html += `<div class="notify-group"><span class="notify-group-name">${escapeHtml(group.name)}</span>`;
        for (const key of present) {
          html += notifyEventOption(key, subscribed.has(key));
        }
        html += "</div>";
      }
      const leftover = titles.filter((key) => !used.has(key));
      if (leftover.length) {
        html += '<div class="notify-group"><span class="notify-group-name">其它</span>';
        for (const key of leftover) {
          html += notifyEventOption(key, subscribed.has(key));
        }
        html += "</div>";
      }
      grid.innerHTML = html || '<p class="muted">没有可订阅的事件</p>';
    } catch (error) {
      grid.innerHTML = `<p class="muted">事件列表加载失败:${escapeHtml(String(error))}</p>`;
    }
  }

  function notifyEventOption(title, checked) {
    return `
      <label class="notify-event">
        <input type="checkbox" data-notify-event="${escapeAttr(title)}" ${checked ? "checked" : ""} />
        <span>${escapeHtml(title)}</span>
      </label>
    `;
  }

  function bindNotifySettingsModal(dialog, { loadSettings }) {
    const status = dialog.querySelector("#notifyStatus");
    const setStatus = (kind, text) => {
      if (!status) return;
      status.hidden = false;
      status.className = `modal-status-line ${kind}`;
      status.textContent = text;
    };

    const saveSettingsPatch = async () => {
      const settings = await loadSettings();
      const patch = {
        ...settings,
        api_hash: "",
        proxy_password: "",
        ...collectNotifyPayload(dialog),
      };
      if (!patch.notify_tg_bot_token) {
        delete patch.notify_tg_bot_token;
      }
      await postJson("/api/settings", patch);
      await loadSettings();
    };

    const saveBtn = dialog.querySelector("#notifySaveBtn");
    if (saveBtn) {
      saveBtn.addEventListener("click", async () => {
        saveBtn.disabled = true;
        setStatus("info", "保存中...");
        try {
          await saveSettingsPatch();
          setStatus("ok", "已保存");
          setTimeout(() => closeModal(), 600);
        } catch (error) {
          setStatus("error", error.message || "保存失败");
          saveBtn.disabled = false;
        }
      });
    }

    const testBtn = dialog.querySelector("#notifyTestBtn");
    if (testBtn) {
      testBtn.addEventListener("click", async () => {
        testBtn.disabled = true;
        setStatus("info", "保存当前配置 + 发测试通知...");
        try {
          await saveSettingsPatch();
          const data = await postJson("/api/notify/test", {});
          if (data.ok) {
            const channels = (data.results || []).map((result) => result.channel).join(", ");
            setStatus("ok", `已发(${channels || "无 channel"}),去 chat 看一下`);
          } else {
            const errors = (data.results || [])
              .filter((result) => !result.ok)
              .map((result) => `${result.channel}: ${result.error}`)
              .join("; ");
            setStatus("error", errors || data.error || "未知错误");
          }
        } catch (error) {
          setStatus("error", error.message || String(error));
        } finally {
          testBtn.disabled = false;
        }
      });
    }
  }

  function collectNotifyPayload(dialog) {
    const enabledEl = dialog.querySelector("#notifyEnabled");
    const tokenEl = dialog.querySelector("#notifyTgBotToken");
    const chatEl = dialog.querySelector("#notifyTgChatId");
    const titles = Array.from(dialog.querySelectorAll("[data-notify-event]:checked"))
      .map((el) => el.dataset.notifyEvent);
    return {
      notify_enabled: !!(enabledEl && enabledEl.checked),
      notify_tg_bot_token: (tokenEl && tokenEl.value) || "",
      notify_tg_chat_id: (chatEl && chatEl.value) || "",
      notify_card_titles: titles,
    };
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.notify = { openNotifySettingsModal };
})();
