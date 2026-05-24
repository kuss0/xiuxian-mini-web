// MINIWEB-VIEW: Telegram account login/logout modals and listen-target renderers
(function () {
  "use strict";

  const { escapeAttr, escapeHtml } = window.MiniwebFormat;

  function renderInput(name, value, placeholder, type = "text", attrs = "") {
    return `<input name="${name}" type="${type}" value="${escapeAttr(value || "")}" placeholder="${escapeAttr(placeholder || "")}" ${attrs} />`;
  }

  function renderAccountModalBody(deps = {}, account, settings, modalState) {
    const acc = account || {};
    const cfg = settings || {};
    const state = modalState || {};
    const savedSecrets = acc.saved_secrets || {};
    const accountSummaryLine = acc.account_id
      ? `<p class="muted">account_id ${escapeHtml(acc.account_id)}｜session ${escapeHtml(acc.session_name || acc.local_id || "未生成")}</p>`
      : "";
    const isLoggedIn = (acc.login_status || "") === "done";
    const listenerStatus = acc.listener_status || "stopped";
    const isCollecting = listenerStatus === "running" || listenerStatus === "starting";
    return `
      <form id="accountModalForm">
        <input type="hidden" name="local_id" value="${escapeAttr(acc.local_id || "")}" />

        <section class="modal-section">
          <h4>基本信息</h4>
          <div class="form-grid">
            <label>
              <span>账号备注</span>
              ${renderInput("label", acc.label || "", "例如 WA2000")}
            </label>
            <label>
              <span>手机号</span>
              ${renderInput("phone", acc.phone || "", "+8613800138000", "tel")}
            </label>
          </div>
          ${accountSummaryLine}
        </section>

        <section class="modal-section">
          <details ${acc.api_id || acc.proxy_type || acc.session_name ? "open" : ""}>
            <summary>高级 / 单账号覆盖（可选,通常不用填）</summary>
            <div>
              <div class="form-grid">
                <label>
                  <span>session 名称</span>
                  ${renderInput("session_name", acc.session_name || "", "不填则按账号 local_id 派生")}
                </label>
                <label>
                  <span>采集优先级(小越优先)</span>
                  ${renderInput("collector_priority", String(acc.collector_priority ?? 100), "100", "text", 'inputmode="numeric"')}
                </label>
                <label>
                  <span>API ID</span>
                  ${renderInput("api_id", acc.api_id || "", "Telegram API ID", "text", 'inputmode="numeric"')}
                </label>
                <label>
                  <span>API Hash</span>
                  ${renderInput("api_hash", "", savedSecrets.api_hash ? "已保存,留空不变" : "Telegram API Hash", "text", 'autocomplete="off"')}
                </label>
                <label>
                  <span>代理类型</span>
                  <select name="proxy_type">
                    <option value="" ${acc.proxy_type ? "" : "selected"}>不使用</option>
                    <option value="http" ${acc.proxy_type === "http" ? "selected" : ""}>HTTP</option>
                    <option value="socks5" ${acc.proxy_type === "socks5" ? "selected" : ""}>SOCKS5</option>
                  </select>
                </label>
                <label>
                  <span>代理 host:port</span>
                  ${renderInput("proxy_host", acc.proxy_host || "", "127.0.0.1:7890")}
                </label>
                <label>
                  <span>代理用户名</span>
                  ${renderInput("proxy_username", acc.proxy_username || "", "")}
                </label>
                <label>
                  <span>代理密码</span>
                  ${renderInput("proxy_password", "", savedSecrets.proxy_password ? "已保存,留空不变" : "", "password", 'autocomplete="off"')}
                </label>
              </div>
            </div>
          </details>
        </section>

        <section class="modal-section login-flow">
          <h4>登录</h4>
          <p class="modal-status-line ${state.statusKind}" data-account-modal-status>${escapeHtml(state.statusText)}</p>

          <div class="login-step" data-account-modal-step="phone">
            <div class="form-actions">
              <button type="button" data-account-modal="send-code">发送验证码</button>
            </div>
          </div>

          <div class="login-step" data-account-modal-step="code" ${state.loginStep === "phone" ? "hidden" : ""}>
            <div class="form-grid">
              <label class="span-2">
                <span>验证码</span>
                <input name="login_code" placeholder="收到的 Telegram 验证码" autocomplete="off" />
              </label>
            </div>
            <div class="form-actions">
              <button type="button" data-account-modal="verify-code">验证</button>
            </div>
          </div>

          <div class="login-step" data-account-modal-step="2fa" ${state.loginStep === "2fa" ? "" : "hidden"}>
            <div class="form-grid">
              <label class="span-2">
                <span>两步验证密码</span>
                <input name="login_password" type="password" placeholder="开启了两步验证才需要" autocomplete="off" />
              </label>
            </div>
            <div class="form-actions">
              <button type="button" data-account-modal="verify-2fa">验证 2FA</button>
            </div>
          </div>
        </section>

        <section class="modal-section listen-target" data-listen-target ${isLoggedIn ? "" : "hidden"}>
          <h4>采集来源</h4>
          <p class="muted">登录后选游戏发生的群和话题(非话题群留空)。游戏 bot 不需要单独配置,会从收到的消息里 <code>sender_is_bot</code> 自动识别。</p>
          <div class="picker-grid">
            <div class="picker-field">
              <div class="picker-head">
                <span>群 / 频道</span>
                <button type="button" data-listen-action="load-dialogs">读取群 / 频道</button>
              </div>
              <select data-listen-select="target_chat">
                <option value="">未选择</option>
              </select>
              ${renderInput("target_chat", acc.target_chat || cfg.target_chat || "", "也可手动填 -100... 或 @username")}
            </div>
            <div class="picker-field">
              <div class="picker-head">
                <span>话题(可选)</span>
                <button type="button" data-listen-action="load-topics">读取话题</button>
              </div>
              <select data-listen-select="target_topic_id">
                <option value="">全部话题 / 不限制</option>
              </select>
              ${renderInput("target_topic_id", acc.target_topic_id || cfg.target_topic_id || "", "话题群留空 = 全部话题", "text", 'inputmode="numeric"')}
            </div>
          </div>
          <p class="modal-status-line info" data-listen-status hidden></p>
          <label class="toggle-row">
            <input type="checkbox" data-listen-collect-now ${isCollecting ? "checked" : ""} />
            <span>保存后立即开始采集(同时只能一个账号采集,会自动停掉其他)</span>
          </label>
          <div class="form-actions">
            <button type="button" class="primary" data-listen-action="save-target">保存采集来源</button>
          </div>
        </section>
      </form>
    `;
  }

  function accountPayloadFromForm(form) {
    const data = new FormData(form);
    return {
      local_id: data.get("local_id"),
      label: data.get("label"),
      phone: data.get("phone"),
      api_id: data.get("api_id"),
      api_hash: data.get("api_hash"),
      session_name: data.get("session_name"),
      target_chat: data.get("target_chat"),
      target_topic_id: data.get("target_topic_id"),
      proxy_type: data.get("proxy_type"),
      proxy_host: data.get("proxy_host"),
      proxy_username: data.get("proxy_username"),
      proxy_password: data.get("proxy_password"),
      collector_priority: data.get("collector_priority") || 100,
      collector_enabled: true,
    };
  }

  function setAccountModalStatus(modalState, dialog, kind, text) {
    if (modalState) {
      modalState.statusKind = kind;
      modalState.statusText = text;
    }
    const line = dialog?.querySelector("[data-account-modal-status]");
    if (line) {
      line.className = `modal-status-line ${kind}`;
      line.textContent = text;
    }
  }

  function setAccountModalStep(modalState, dialog, step) {
    if (modalState) {
      modalState.loginStep = step;
    }
    ["phone", "code", "2fa"].forEach((name) => {
      const node = dialog?.querySelector(`[data-account-modal-step="${name}"]`);
      if (!node) return;
      const shouldHide = (name === "code" && step === "phone") || (name === "2fa" && step !== "2fa");
      node.hidden = shouldHide;
    });
  }

  function revealListenTarget(dialog) {
    const section = dialog?.querySelector("[data-listen-target]");
    if (section) section.hidden = false;
  }

  function setListenTargetStatus(dialog, kind, text) {
    const line = dialog?.querySelector("[data-listen-status]");
    if (!line) return;
    line.hidden = !text;
    line.className = `modal-status-line ${kind}`;
    line.textContent = text || "";
  }

  function populateListenTargetSelect(select, items, currentValue, valueKey, labelFn) {
    if (!select) return;
    const rows = Array.isArray(items) ? items : [];
    const current = String(currentValue || "");
    const knownIds = new Set(rows.map((item) => String(item[valueKey])));
    const stayCurrent = current && !knownIds.has(current);
    const emptyLabel = select.dataset.listenSelect === "target_topic_id"
      ? "全部话题 / 不限制"
      : "未选择";
    select.innerHTML = `
      <option value="">${emptyLabel}</option>
      ${stayCurrent ? `<option value="${escapeAttr(current)}" selected>当前手填: ${escapeHtml(current)}</option>` : ""}
      ${rows.map((item) => {
        const value = String(item[valueKey]);
        return `<option value="${escapeAttr(value)}" ${value === current ? "selected" : ""}>${escapeHtml(labelFn(item))}</option>`;
      }).join("")}
    `;
  }

  function dialogKindLabel(kind) {
    if (kind === "supergroup") return "超级群";
    if (kind === "channel") return "频道";
    if (kind === "group") return "群";
    return "会话";
  }

  function accountManagementState(deps = {}) {
    return deps.state || window.MiniwebState?.state || {};
  }

  function loggedInAccounts(deps = {}) {
    const state = accountManagementState(deps);
    return (state.accounts || []).filter((account) => (account.login_status || "") === "done");
  }

  function renderCurrentAccountLine(deps = {}) {
    const loggedIn = loggedInAccounts(deps);
    if (loggedIn.length === 0) {
      return "当前账号: 未登录";
    }
    if (loggedIn.length === 1) {
      const account = loggedIn[0];
      const id = account.account_id ? ` (${account.account_id})` : "";
      return `当前账号: ${account.label || account.local_id}${id}`;
    }
    return `已登录 ${loggedIn.length} 个账号`;
  }

  function updateCurrentAccountLine(deps = {}, line) {
    if (!line) return;
    line.textContent = renderCurrentAccountLine(deps);
  }

  function updateAccountActionGuards(deps = {}, nodes = {}) {
    const state = accountManagementState(deps);
    const loggedInCount = loggedInAccounts(deps).length;
    const anyCount = (state.accounts || []).length;
    const addIdentityButton = nodes.addIdentityButton || null;
    const logoutAccountButton = nodes.logoutAccountButton || null;
    if (addIdentityButton) {
      addIdentityButton.disabled = loggedInCount === 0;
      addIdentityButton.title = loggedInCount === 0
        ? "需要先登录至少一个 Telegram 账号才能新增身份"
        : "选账号 → 拉可用 send_as 列表 → 勾选保存";
    }
    if (logoutAccountButton) {
      logoutAccountButton.disabled = loggedInCount === 0;
      logoutAccountButton.title = loggedInCount === 0
        ? (anyCount === 0 ? "还没有任何 Telegram 账号" : "保存的账号都未登录,无可登出")
        : "登出指定账号(只清 session,不删账号和身份)";
    }
  }

  function renderLogoutEmptyBody() {
    return `<section class="modal-section"><p class="modal-status-line info">当前没有已登录的账号,无需登出。</p></section>`;
  }

  function renderLogoutEmptyFooter() {
    return `<button type="button" data-modal-close>知道了</button>`;
  }

  function renderLogoutAccountModalBody(deps = {}, loggedInAccounts = [], presetLocalId = "") {
    const options = loggedInAccounts
      .map((account) => {
        const label = `${account.label || account.local_id}｜${account.account_id || account.local_id}`;
        const selected = account.local_id === presetLocalId ? "selected" : "";
        return `<option value="${escapeAttr(account.local_id)}" ${selected}>${escapeHtml(label)}</option>`;
      })
      .join("");
    return `
      <section class="modal-section">
        <label>
          <span>选要登出的账号</span>
          <select id="logoutAccountSelect">${options}</select>
        </label>
        <p class="modal-status-line warn">这会移除本地登录态并清理 session 文件,但<strong>不会</strong>删除已添加的身份。</p>
        <p class="modal-status-line info">绑定身份会被暂停;重新登录同一账号后可继续使用。</p>
        <p class="modal-status-line info" id="logoutBoundIdentities"></p>
        <p class="modal-status-line" id="logoutResult" hidden></p>
      </section>
    `;
  }

  function renderLogoutAccountModalFooter() {
    return `
      <button type="button" data-modal-close>取消</button>
      <button type="button" class="primary" id="logoutConfirmBtn">确认登出</button>
    `;
  }

  function logoutBoundIdentityText(count) {
    return count
      ? `该账号当前绑定 ${count} 条身份(不会被删除,但会暂停)。`
      : "该账号当前没有绑定身份。";
  }

  function selectedLogoutAccountId(dialog) {
    return dialog?.querySelector("#logoutAccountSelect")?.value || "";
  }

  function updateLogoutBoundIdentities(dialog, identities = []) {
    const localId = selectedLogoutAccountId(dialog);
    const line = dialog?.querySelector("#logoutBoundIdentities");
    if (!line) return;
    const count = identities.filter((identity) => identity.account_local_id === localId).length;
    line.textContent = logoutBoundIdentityText(count);
  }

  function setLogoutResult(dialog, kind, text) {
    const line = dialog?.querySelector("#logoutResult");
    if (!line) return;
    line.hidden = !text;
    line.className = `modal-status-line ${kind}`;
    line.textContent = text || "";
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.accountManagement = {
    renderAccountModalBody,
    accountPayloadFromForm,
    setAccountModalStatus,
    setAccountModalStep,
    revealListenTarget,
    setListenTargetStatus,
    populateListenTargetSelect,
    dialogKindLabel,
    renderCurrentAccountLine,
    updateCurrentAccountLine,
    updateAccountActionGuards,
    renderLogoutEmptyBody,
    renderLogoutEmptyFooter,
    renderLogoutAccountModalBody,
    renderLogoutAccountModalFooter,
    selectedLogoutAccountId,
    updateLogoutBoundIdentities,
    setLogoutResult,
  };
})();
