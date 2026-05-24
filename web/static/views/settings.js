// MINIWEB-VIEW: access settings modal and automation guard form
(function () {
  "use strict";

  const { openModal } = window.MiniwebModal;
  const { escapeAttr, escapeHtml } = window.MiniwebFormat;

  function settingsState(deps = {}) {
    return deps.state || window.MiniwebState?.state || {};
  }

  function renderSettings(deps = {}, settings = {}) {
    const state = settingsState(deps);
    state.detailMode = "message";
    const dialog = openModal({
      title: "接入配置",
      body: renderSettingsBody(deps, state, settings),
      footer: `<button type="button" data-modal-close>关闭</button>`,
    });
    if (!dialog) return null;
    bindSettingsModal(deps, dialog, settings);
    return dialog;
  }

  function renderSettingsBody(deps = {}, state = {}, settings = {}) {
    const botIds = (settings.game_bot_ids || []).join("\n");
    const automationSkillKeys = (settings.automation_allowed_skill_keys || []).join("\n");
    const automationIdentityIds = (settings.automation_allowed_identity_ids || []).join("\n");
    const savedSecrets = settings.saved_secrets || {};
    const dialogOptions = deps.renderDialogOptions?.(settings.target_chat) || "";
    const topicOptions = deps.renderTopicOptions?.(settings.target_topic_id) || "";
    const accountCount = state.accounts?.length || 0;
    const accountLimit = state.accountLimit || 0;
    const identityCount = state.identities?.length || 0;
    const identityLimit = state.identityLimit || 0;
    return `
      <form id="settingsForm" class="settings-form">
        <div class="detail-block">
          <h4>Telegram 接入</h4>
          <p>默认接入配置保存在本地 SQLite，暂不做加密。采集监听只需要一个账号，用来把游戏群消息写入本地消息箱。</p>
          <p>登录状态：${escapeHtml(settings.login_status || "idle")} ${settings.login_account_id ? `｜账号 ${escapeHtml(settings.login_account_id)}` : ""}</p>
          ${settings.login_message ? `<p>${escapeHtml(settings.login_message)}</p>` : ""}
          <p id="listenerStatusText">监听状态：${escapeHtml(settings.listener_status || "stopped")} ${settings.listener_message ? `｜${escapeHtml(settings.listener_message)}` : ""}</p>
          <p>多账号：${accountCount}${accountLimit ? ` / ${accountLimit}` : ""} 个已保存</p>
          <p>游戏身份：${identityCount}${identityLimit ? ` / ${identityLimit}` : ""} 个已保存</p>
          ${state.settingsNotice ? `<p class="settings-notice">${escapeHtml(state.settingsNotice)}</p>` : ""}
        </div>

        <div class="form-grid">
          <label>
            <span>API ID</span>
            <input name="api_id" inputmode="numeric" value="${escapeAttr(settings.api_id)}" placeholder="Telegram API ID" />
          </label>
          <label>
            <span>API Hash</span>
            <input
              name="api_hash"
              value=""
              placeholder="${savedSecrets.api_hash ? "已保存，留空不变；重新填写则覆盖" : "Telegram API Hash"}"
              autocomplete="off"
            />
          </label>
          <label>
            <span>手机号</span>
            <input name="phone" value="${escapeAttr(settings.phone)}" placeholder="+8613800138000" />
          </label>
          <label>
            <span>Session 名称</span>
            <input name="session_name" value="${escapeAttr(settings.session_name)}" placeholder="miniweb_session" />
          </label>
        </div>

        <div class="picker-grid">
          <div class="picker-field">
            <div class="picker-head">
              <span>目标群 / 频道</span>
              <button type="button" data-telegram-action="load-dialogs">读取群 / 频道</button>
            </div>
            <select data-select-target="target_chat">
              <option value="">未选择</option>
              ${dialogOptions}
            </select>
            <input name="target_chat" value="${escapeAttr(settings.target_chat)}" placeholder="可手动填写 -100... 或 @username" />
          </div>

          <div class="picker-field">
            <div class="picker-head">
              <span>话题</span>
              <button type="button" data-telegram-action="load-topics">读取话题</button>
            </div>
            <select data-select-target="target_topic_id">
              <option value="">全部话题 / 不限制</option>
              ${topicOptions}
            </select>
            <input name="target_topic_id" inputmode="numeric" value="${escapeAttr(settings.target_topic_id)}" placeholder="可留空，也可手动填写话题 ID" />
          </div>
        </div>

        <label class="stacked-field">
          <span>已知天尊 sender IDs</span>
          <textarea name="game_bot_ids" rows="6" placeholder="-1003983937918&#10;7900199668">${escapeHtml(botIds)}</textarea>
        </label>

        <div class="detail-block">
          <h4>自动发送守卫</h4>
          <p class="muted" style="font-size:12px;">默认只做 dry-run 演练。只有开启自动发送、命中技能/身份白名单、通过幂等和限速后，才会交给 user-session 发送适配器。</p>
          <div class="form-grid">
            <label class="toggle-field">
              <input type="checkbox" name="automation_enabled" ${settings.automation_enabled ? "checked" : ""} />
              <span>启用自动发送</span>
            </label>
            <label class="toggle-field">
              <input type="checkbox" name="automation_dry_run" ${settings.automation_dry_run !== false ? "checked" : ""} />
              <span>dry-run 演练</span>
            </label>
            <label>
              <span>每分钟上限</span>
              <input name="automation_max_per_minute" inputmode="numeric" value="${escapeAttr(settings.automation_max_per_minute || 6)}" />
            </label>
            <label>
              <span>发送适配器</span>
              <select name="automation_sender_adapter">
                <option value="user_session" ${(settings.automation_sender_adapter || "user_session") === "user_session" ? "selected" : ""}>user_session</option>
                <option value="ayugram_ipc" ${settings.automation_sender_adapter === "ayugram_ipc" ? "selected" : ""}>ayugram_ipc（未接入）</option>
                <option value="ayugram_gui" ${settings.automation_sender_adapter === "ayugram_gui" ? "selected" : ""}>ayugram_gui（未接入）</option>
              </select>
            </label>
          </div>
          <div class="form-grid">
            <label>
              <span>技能白名单</span>
              <textarea name="automation_allowed_skill_keys" rows="5" placeholder="storage_bag&#10;battle_power">${escapeHtml(automationSkillKeys)}</textarea>
            </label>
            <label>
              <span>身份白名单</span>
              <textarea name="automation_allowed_identity_ids" rows="5" placeholder="留空=所有已解析身份">${escapeHtml(automationIdentityIds)}</textarea>
            </label>
            <label>
              <span>worker 间隔秒</span>
              <input name="automation_worker_interval_seconds" inputmode="numeric" value="${escapeAttr(settings.automation_worker_interval_seconds || 15)}" />
            </label>
            <label>
              <span>worker 批量</span>
              <input name="automation_worker_batch_size" inputmode="numeric" value="${escapeAttr(settings.automation_worker_batch_size || 3)}" />
            </label>
            <label class="toggle-field">
              <input type="checkbox" name="automation_worker_enabled" ${settings.automation_worker_enabled ? "checked" : ""} />
              <span>启用自动队列 worker</span>
            </label>
          </div>
        </div>

        <div class="form-grid">
          <label>
            <span>代理类型</span>
            <select name="proxy_type">
              <option value="" ${settings.proxy_type ? "" : "selected"}>不使用</option>
              <option value="http" ${settings.proxy_type === "http" ? "selected" : ""}>HTTP</option>
              <option value="socks5" ${settings.proxy_type === "socks5" ? "selected" : ""}>SOCKS5</option>
            </select>
          </label>
          <label>
            <span>代理 host:port</span>
            <input name="proxy_host" value="${escapeAttr(settings.proxy_host)}" placeholder="127.0.0.1:7890" />
          </label>
          <label>
            <span>代理用户名</span>
            <input name="proxy_username" value="${escapeAttr(settings.proxy_username)}" />
          </label>
          <label>
            <span>代理密码</span>
            <input
              name="proxy_password"
              type="password"
              value=""
              placeholder="${savedSecrets.proxy_password ? "已保存，留空不变；重新填写则覆盖" : ""}"
              autocomplete="off"
            />
          </label>
        </div>

        <div class="form-actions">
          <button type="button" data-login-action="start">发送验证码</button>
          <button type="button" data-login-action="cancel">取消登录</button>
          <button type="submit">保存配置</button>
        </div>

        <div class="detail-block notify-section">
          <h4>🔔 通知设置</h4>
          <p class="muted" style="font-size:12px;">关键事件(风险/突破/奇遇 prompt 等)可推送到独立的 Telegram bot。
          后续会加 Bark / 钉钉 / 浏览器 push。</p>
          <label class="toggle-field">
            <input type="checkbox" name="notify_enabled" ${settings.notify_enabled ? "checked" : ""} />
            <span>启用通知</span>
          </label>
          <div class="form-grid">
            <label>
              <span>Telegram Bot Token</span>
              <input
                name="notify_tg_bot_token"
                value=""
                placeholder="${savedSecrets.notify_tg_bot_token ? "已保存,留空不变" : "BotFather 拿到的 token,形如 123:ABC..."}"
                autocomplete="off"
              />
            </label>
            <label>
              <span>Telegram Chat ID</span>
              <input name="notify_tg_chat_id" value="${escapeAttr(settings.notify_tg_chat_id || "")}" placeholder="接收方的 chat ID(私聊 = user_id;群 = -100xxx)" />
            </label>
          </div>
          <div class="notify-event-grid" id="notifyEventGrid">
            <p class="muted" style="font-size:11px;">加载中…</p>
          </div>
          <div class="form-actions">
            <button type="button" data-notify-action="test">发测试通知</button>
          </div>
          <p id="notifyTestResult" class="muted" style="font-size:12px;"></p>
        </div>

        <div class="login-verify">
          <label>
            <span>验证码</span>
            <input name="login_code" placeholder="Telegram 验证码" />
          </label>
          <label>
            <span>两步验证密码</span>
            <input name="login_password" type="password" placeholder="需要时填写" />
          </label>
          <button type="button" data-login-action="verify">验证登录</button>
        </div>
      </form>

      <div class="detail-block account-manager">
        <div class="manager-head">
          <div>
            <h4>Telegram 账号</h4>
            <p>每个账号是一份 Telegram session,只读它说话。同时只能选一个账号采集消息进消息箱,其他账号留作以备身份归属用。</p>
          </div>
          <button type="button" class="primary" data-account-action="open-new">+ 登录账号</button>
        </div>
        <div id="accountList" class="account-list slim">
          ${renderAccountList(deps)}
        </div>
      </div>
    `;
  }

  function renderAccountList(deps = {}) {
    const state = settingsState(deps);
    if (!state.accounts?.length) {
      return `<p class="empty inline">还没有 Telegram 账号。点右上角「+ 登录账号」把账号挂上来,把消息搬进消息箱。</p>`;
    }
    const running = state.listenerSummary?.running || {};
    const collector = state.listenerSummary?.collector || "";
    return state.accounts
      .map((account) => {
        const listener = running[account.local_id] || {};
        const listenerStatus = listener.status || account.listener_status || "stopped";
        const isCollecting =
          collector === account.local_id ||
          listenerStatus === "running" ||
          listenerStatus === "starting" ||
          listenerStatus === "reconnecting";
        const loginStatus = account.login_status || "idle";
        const loginPill = renderAccountStatusPill(loginStatus);
        const collectPill = isCollecting
          ? (listenerStatus === "reconnecting"
            ? '<span class="status-pill warn">重连中</span>'
            : '<span class="status-pill ok">采集中</span>')
          : listenerStatus === "error"
            ? `<span class="status-pill risk">采集出错</span>`
            : '<span class="status-pill">未采集</span>';
        const subtitle = [
          account.phone || "未填手机号",
          account.account_id ? `account_id ${account.account_id}` : "",
        ]
          .filter(Boolean)
          .join("｜");
        return `
          <article class="account-row" data-account-id="${escapeAttr(account.local_id)}">
            <span class="account-row-dot ${isCollecting ? "live" : loginStatus === "done" ? "ok" : loginStatus === "error" ? "warn" : "idle"}" aria-hidden="true"></span>
            <div class="account-row-body">
              <div class="account-row-title">
                <strong>${escapeHtml(account.label || account.local_id)}</strong>
                <span class="account-row-meta">${escapeHtml(subtitle)}</span>
              </div>
              <div class="account-row-pills">
                ${loginPill}
                ${collectPill}
              </div>
            </div>
            <div class="account-row-actions">
              <label class="switch" title="切到这个账号采集消息;同时只能一个">
                <input type="checkbox" data-account-action="toggle-collect" data-account-id="${escapeAttr(account.local_id)}" ${isCollecting ? "checked" : ""} />
                <span></span>
              </label>
              <button type="button" data-account-action="open-edit" data-account-id="${escapeAttr(account.local_id)}">${loginStatus === "done" ? "编辑" : "登录"}</button>
              <button type="button" class="danger-link" data-account-action="delete" data-account-id="${escapeAttr(account.local_id)}" title="删除账号">删除</button>
            </div>
          </article>
        `;
      })
      .join("");
  }

  function renderAccountStatusPill(status) {
    if (status === "done") {
      return '<span class="status-pill ok">已登录</span>';
    }
    if (status === "waiting_code" || status === "need_2fa") {
      return `<span class="status-pill warn">${status === "need_2fa" ? "需要 2FA" : "等验证码"}</span>`;
    }
    if (status === "error") {
      return '<span class="status-pill risk">登录出错</span>';
    }
    return '<span class="status-pill">未登录</span>';
  }

  function bindSettingsModal(deps = {}, dialog, settings = {}) {
    const state = settingsState(deps);
    const root = dialog.querySelector(".modal-body") || dialog;
    deps.loadListenerStatus?.()
      .then((listener) => {
        const target = root.querySelector("#listenerStatusText");
        if (target) {
          target.textContent = `监听状态：${listener.status} ${listener.message || ""}`;
        }
      })
      .catch(() => {});

    hydrateNotifySection(deps, settings, root);

    root.querySelector("#settingsForm")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const saved = await deps.saveCurrentSettingsFromForm?.(event.currentTarget);
        deps.setSettingsNotice?.("配置已保存");
        deps.rerenderSettings?.(saved);
        deps.showSkillToast?.("接入配置已保存", "ok");
      } catch (error) {
        deps.showError?.(error);
      }
    });

    root.querySelectorAll("[data-select-target]").forEach((select) => {
      select.addEventListener("change", () => {
        const form = root.querySelector("#settingsForm");
        const input = form?.querySelector(`[name="${select.dataset.selectTarget}"]`);
        if (input) {
          input.value = select.value;
        }
        if (select.dataset.selectTarget === "target_chat") {
          state.telegramTopics = [];
          const topicInput = form?.querySelector('[name="target_topic_id"]');
          const topicSelect = form?.querySelector('[data-select-target="target_topic_id"]');
          if (topicInput && topicSelect) {
            topicInput.value = "";
            topicSelect.value = "";
          }
        }
      });
    });

    root.querySelectorAll("[data-telegram-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const form = root.querySelector("#settingsForm");
        button.disabled = true;
        try {
          await deps.saveCurrentSettingsFromForm?.(form);
          if (button.dataset.telegramAction === "load-dialogs") {
            deps.setSettingsNotice?.("正在读取当前账号可见的群 / 频道...");
            const dialogs = await deps.loadTelegramDialogs?.();
            deps.setSettingsNotice?.((dialogs || []).length
              ? `已读取 ${(dialogs || []).length} 个群 / 频道，请从下拉框选择。`
              : "没有读取到可用群 / 频道。");
          } else if (button.dataset.telegramAction === "load-topics") {
            const targetChat = new FormData(form).get("target_chat");
            if (!String(targetChat || "").trim()) {
              throw new Error("请先选择目标群 / 频道");
            }
            deps.setSettingsNotice?.("正在读取该群的话题...");
            const topics = await deps.loadTelegramTopics?.(targetChat);
            deps.setSettingsNotice?.((topics || []).length
              ? `已读取 ${(topics || []).length} 个话题，请从下拉框选择。`
              : "该群没有读取到话题，或不是话题群。");
          }
          const latest = await deps.loadSettings?.();
          deps.rerenderSettings?.(latest);
        } catch (error) {
          deps.setSettingsNotice?.(error.message || String(error));
          deps.rerenderSettings?.(state.settings || settings);
        }
      });
    });

    root.querySelectorAll("[data-login-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const form = root.querySelector("#settingsForm");
        try {
          let result = null;
          if (button.dataset.loginAction === "start") {
            await deps.saveCurrentSettingsFromForm?.(form);
            result = await deps.startLogin?.();
            if (!result?.ok) {
              throw new Error(result?.error || "发送验证码失败");
            }
          } else if (button.dataset.loginAction === "verify") {
            result = await deps.verifyLogin?.({
              code: new FormData(form).get("login_code"),
              password: new FormData(form).get("login_password"),
            });
            if (!result?.ok && result?.status !== "need_2fa") {
              throw new Error(result?.error || "登录验证失败");
            }
          } else if (button.dataset.loginAction === "cancel") {
            result = await deps.cancelLogin?.();
            if (!result?.ok) {
              throw new Error(result?.error || "取消失败");
            }
          }
          const latest = await deps.loadSettings?.();
          deps.rerenderSettings?.(latest);
        } catch (error) {
          deps.showError?.(error);
        }
      });
    });

    deps.bindAccountControls?.(root);
  }

  function settingsPayloadFromForm(form) {
    const data = new FormData(form);
    const notifyTitles = Array.from(
      form.querySelectorAll('input[name="notify_card_titles"]:checked')
    ).map((el) => el.value);
    return {
      api_id: data.get("api_id"),
      api_hash: data.get("api_hash"),
      phone: data.get("phone"),
      session_name: data.get("session_name"),
      target_chat: data.get("target_chat"),
      target_topic_id: data.get("target_topic_id"),
      game_bot_ids: splitLines(data.get("game_bot_ids")),
      proxy_type: data.get("proxy_type"),
      proxy_host: data.get("proxy_host"),
      proxy_username: data.get("proxy_username"),
      proxy_password: data.get("proxy_password"),
      notify_enabled: !!form.querySelector('input[name="notify_enabled"]:checked'),
      notify_tg_bot_token: data.get("notify_tg_bot_token"),
      notify_tg_chat_id: data.get("notify_tg_chat_id"),
      notify_card_titles: notifyTitles,
      automation_enabled: !!form.querySelector('input[name="automation_enabled"]:checked'),
      automation_dry_run: !!form.querySelector('input[name="automation_dry_run"]:checked'),
      automation_allowed_skill_keys: splitLines(data.get("automation_allowed_skill_keys")),
      automation_allowed_identity_ids: splitLines(data.get("automation_allowed_identity_ids")),
      automation_max_per_minute: data.get("automation_max_per_minute"),
      automation_sender_adapter: data.get("automation_sender_adapter"),
      automation_worker_enabled: !!form.querySelector('input[name="automation_worker_enabled"]:checked'),
      automation_worker_interval_seconds: data.get("automation_worker_interval_seconds"),
      automation_worker_batch_size: data.get("automation_worker_batch_size"),
    };
  }

  function splitLines(value) {
    return String(value || "")
      .split(/\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  async function hydrateNotifySection(deps = {}, settings = {}, root = document) {
    const grid = root.querySelector("#notifyEventGrid");
    if (!grid) return;
    const enabled = new Set(settings.notify_card_titles || []);
    try {
      const data = await deps.loadNotifyCardTitles?.();
      const titles = data?.titles || [];
      const groups = [
        { name: "🚨 高危", keys: ["风险提醒", "天道审判"] },
        { name: "🎯 prompt", keys: ["玄骨考校", "天机考验", "极阴祖师", "南陇侯", "共历心劫", "第二元神归位"] },
        { name: "🎉 里程碑", keys: ["境界突破", "赐予道号", "试炼古塔战报", "深度闭关总结", "闭关成功"] },
        { name: "📦 副本/物品", keys: ["虚天殿开启", "加入副本成功", "加入副本失败", "副本房间解散", "储物袋快照", "灵树采摘"] },
      ];
      const used = new Set();
      let html = "";
      for (const group of groups) {
        const present = group.keys.filter((key) => titles.includes(key));
        if (!present.length) continue;
        present.forEach((key) => used.add(key));
        html += `<div class="notify-group"><span class="notify-group-name">${escapeHtml(group.name)}</span>`;
        for (const key of present) {
          html += `<label class="notify-event"><input type="checkbox" name="notify_card_titles" value="${escapeAttr(key)}" ${enabled.has(key) ? "checked" : ""} /> <span>${escapeHtml(key)}</span></label>`;
        }
        html += "</div>";
      }
      const leftover = titles.filter((key) => !used.has(key));
      if (leftover.length) {
        html += `<div class="notify-group"><span class="notify-group-name">其它</span>`;
        for (const key of leftover) {
          html += `<label class="notify-event"><input type="checkbox" name="notify_card_titles" value="${escapeAttr(key)}" ${enabled.has(key) ? "checked" : ""} /> <span>${escapeHtml(key)}</span></label>`;
        }
        html += "</div>";
      }
      grid.innerHTML = html || '<p class="muted">没有可订阅事件</p>';
    } catch (error) {
      grid.innerHTML = `<p class="muted">事件列表加载失败:${escapeHtml(String(error))}</p>`;
    }

    root.querySelectorAll('[data-notify-action="test"]').forEach((button) => {
      button.addEventListener("click", async () => {
        const resultEl = root.querySelector("#notifyTestResult");
        button.disabled = true;
        if (resultEl) resultEl.textContent = "正在发送测试...";
        try {
          const form = button.closest("form");
          if (form) await deps.saveCurrentSettingsFromForm?.(form);
          const data = await deps.sendNotifyTest?.();
          if (data?.ok) {
            const channels = (data.results || []).map((item) => item.channel).join(",");
            if (resultEl) resultEl.textContent = `✅ 测试通知已发(${channels})`;
          } else {
            const errs =
              (data?.results || [])
                .filter((item) => !item.ok)
                .map((item) => `${item.channel}: ${item.error}`)
                .join("; ") ||
              data?.error ||
              "未知错误";
            if (resultEl) resultEl.textContent = `❌ ${errs}`;
          }
        } catch (error) {
          if (resultEl) resultEl.textContent = `❌ ${error.message || error}`;
        } finally {
          button.disabled = false;
        }
      });
    });
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.settings = {
    renderSettings,
    renderSettingsBody,
    renderAccountList,
    renderAccountStatusPill,
    bindSettingsModal,
    settingsPayloadFromForm,
    hydrateNotifySection,
  };
})();
