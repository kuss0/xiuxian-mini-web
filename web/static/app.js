// MINIWEB-BUILD: dark-sidebar-identity 2026-05-16T02:00
console.log("[mini-web] build: dark-sidebar-identity 2026-05-16T02:00 — 如看到此行,说明新 JS 已加载");

const state = {
  channels: [],
  selectedChannels: new Set(),
  messages: [],
  selectedMessageId: null,
  expandedMessages: new Set(),
  settings: null,
  accounts: [],
  identities: [],
  identityPatches: [],
  accountLimit: 0,
  identityLimit: 0,
  listenerSummary: null,
  telegramDialogs: [],
  telegramTopics: [],
  settingsNotice: "",
  outboxPlan: null,
  outboxDrafts: [],
  draftNoticeByMessageId: new Map(),
  detailMode: "message",
  refreshState: "idle",
  activeIdentityId: null,
  discoveredBots: [],
  lastMessageSeq: 0,
  viewMode: "solo",
  sendAs: {
    peers: [],
    accountLocalId: "",
    selected: new Set(),
  },
  // 玩法状态机:Map<send_as_id(number), Array<{module_key,label,summary,state}>>
  identityModuleStates: new Map(),
};

const MESSAGE_PREVIEW_CHAR_LIMIT = 480;
const MESSAGE_PREVIEW_LINE_LIMIT = 8;
const NUMERIC_SOURCE_RE = /^-?\d{4,}$/;

const channelFilters = document.querySelector("#channelFilters");
const selectAllChannels = document.querySelector("#selectAllChannels");
const messageList = document.querySelector("#messageList");
const messageCount = document.querySelector("#messageCount");
const activeChannelText = document.querySelector("#activeChannelText");
const detailPanel = document.querySelector("#detailPanel");
const detailState = document.querySelector("#detailState");
const identitySnapshot = document.querySelector("#identitySnapshot");
const refreshButton = document.querySelector("#refreshButton");
const outboxButton = document.querySelector("#outboxButton");
const scheduleButton = document.querySelector("#scheduleButton");
const logsButton = document.querySelector("#logsButton");
const loginAccountButton = document.querySelector("#loginAccountButton");
const addIdentityButton = document.querySelector("#addIdentityButton");
const logoutAccountButton = document.querySelector("#logoutAccountButton");
const sidebarIdentityList = document.querySelector("#identityList");
const currentAccountLine = document.querySelector("#currentAccountLine");
const gameBotsButton = document.querySelector("#gameBotsButton");
const globalBanner = document.querySelector("#globalBanner");
const viewModeAllButton = null;
const viewModeSoloButton = null;
const jumpToLatestButton = document.querySelector("#jumpToLatest");
const modalRoot = document.querySelector("#modalRoot");
const AUTH_TOKEN_STORAGE_KEY = "xiuxianMiniwebAccessToken";

let modalCloseHandler = null;

function openModal({ title, body, footer }) {
  if (!modalRoot) return;
  modalRoot.innerHTML = `
    <div class="modal-dialog" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3>${escapeHtml(title || "")}</h3>
        <button type="button" class="modal-close" data-modal-close aria-label="关闭">×</button>
      </div>
      <div class="modal-body">${body || ""}</div>
      ${footer ? `<div class="modal-actions">${footer}</div>` : ""}
    </div>
  `;
  modalRoot.hidden = false;
  modalCloseHandler = (event) => {
    if (event.key === "Escape") {
      closeModal();
    }
  };
  document.addEventListener("keydown", modalCloseHandler);
  modalRoot.querySelectorAll("[data-modal-close]").forEach((button) => {
    button.addEventListener("click", () => closeModal());
  });
  modalRoot.addEventListener("click", (event) => {
    if (event.target === modalRoot) {
      closeModal();
    }
  });
  return modalRoot.querySelector(".modal-dialog");
}

function closeModal() {
  if (!modalRoot) return;
  modalRoot.hidden = true;
  modalRoot.innerHTML = "";
  if (modalCloseHandler) {
    document.removeEventListener("keydown", modalCloseHandler);
    modalCloseHandler = null;
  }
}

async function fetchJson(url) {
  const response = await apiFetch(url);
  if (!response.ok) {
    throw new Error(`请求失败：${response.status}`);
  }
  return response.json();
}

async function apiFetch(url, options = {}, allowRetry = true) {
  const response = await fetch(url, {
    ...options,
    headers: authHeaders(options.headers),
  });
  if (response.status !== 401 || !allowRetry) {
    return response;
  }

  sessionStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  const token = window.prompt("请输入 Mini Web 访问口令");
  if (!token) {
    return response;
  }
  sessionStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token.trim());
  return apiFetch(url, options, false);
}

function authHeaders(headers = {}) {
  const merged = { ...headers };
  const token = sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  if (token) {
    merged["X-Miniweb-Token"] = token;
  }
  return merged;
}

async function loadChannels() {
  const payload = await fetchJson("/api/channels");
  state.channels = payload.channels;
  state.selectedChannels = new Set(state.channels.map((channel) => channel.key));
  renderChannelFilters();
}

async function loadMessages({ incremental = false } = {}) {
  // 增量:轮询用,只拉 rowid > lastSeq 的新卡片(可能 0 条)
  // 初始化:首次/手动刷新用,拉最近 200 条
  // mode:默认 solo(只我和天尊),不依赖前端窗口;日志按钮单独走 modal
  const params = new URLSearchParams({ channel: "all" });
  const mode = state.viewMode === "solo" ? "solo" : "";
  if (mode) params.set("mode", mode);
  if (incremental && state.lastMessageSeq > 0) {
    params.set("since_seq", String(state.lastMessageSeq));
  } else {
    params.set("limit", "200");
  }
  const payload = await fetchJson(`/api/messages?${params.toString()}`);
  const incoming = payload.messages || [];
  const serverMax = Number(payload.max_seq || 0);

  // 游标跑过头检测:服务端 max_seq 突然小于本地 lastSeq → DB 重置 / parsed_cards 重建,
  // 这时不能按 max 取(永远走不到),要把本地游标重置并重新初始化。
  if (incremental && serverMax > 0 && state.lastMessageSeq > serverMax + 5) {
    console.warn("[poll] seq reset detected: local", state.lastMessageSeq, "> server max", serverMax, "→ re-init");
    state.lastMessageSeq = 0;
    state.messages = [];
    return loadMessages({ incremental: false });
  }

  if (incremental) {
    // merge 进现有 state.messages,按 id 去重
    if (incoming.length === 0) {
      state.lastMessageSeq = Math.max(state.lastMessageSeq, serverMax);
      return;
    }
    const byId = new Map(state.messages.map((m) => [m.id, m]));
    for (const card of incoming) {
      byId.set(card.id, card);  // 同 id 的会被新版本覆盖(支持 edit)
    }
    // 按 seq 倒序(新的在前) — 跟初始化一致
    state.messages = Array.from(byId.values()).sort((a, b) => (b.seq || 0) - (a.seq || 0));
  } else {
    // 初始化:直接替换
    state.messages = incoming;
  }
  state.lastMessageSeq = Math.max(state.lastMessageSeq, serverMax);

  if (!visibleMessages().some((message) => message.id === state.selectedMessageId)) {
    state.selectedMessageId = visibleMessages()[0]?.id ?? null;
  }
  renderMessages();
  // 轮询走的增量更新不要碰右侧详情面板 — 用户可能正在看某条消息的详情,
  // 重渲会让按钮和滚动闪一下。初始化 / 手动刷新才重渲详情。
  if (!incremental && state.detailMode === "message") {
    renderDetail();
  }
}

async function loadOutboxDrafts() {
  const payload = await fetchJson("/api/outbox/drafts?status=draft");
  state.outboxDrafts = payload.drafts || [];
  return state.outboxDrafts;
}

async function loadSettings() {
  const payload = await fetchJson("/api/settings");
  state.settings = payload.settings;
  return state.settings;
}

async function loadAccounts() {
  const payload = await fetchJson("/api/accounts");
  state.accounts = payload.accounts || [];
  state.accountLimit = payload.max_accounts || 0;
  state.listenerSummary = payload.listener || null;
  renderSidebarIdentityList();
  updateCurrentAccountLine();
  updateAccountActionGuards();
  return payload;
}

async function loadIdentities() {
  const payload = await fetchJson("/api/identities");
  state.identities = payload.identities || [];
  state.identityLimit = payload.max_identities || 0;
  renderSidebarIdentityList();
  // 身份状态机摘要(深度闭关 / 抚摸 / 温养)— 失败不阻塞
  loadIdentityModuleStates().catch((err) => console.warn("[mini-web] identity state fetch failed:", err));
  return payload;
}

async function loadIdentityModuleStates() {
  try {
    const payload = await fetchJson("/api/identity-state");
    const map = new Map();
    for (const entry of payload.by_identity || []) {
      map.set(Number(entry.send_as_id), entry.items || []);
    }
    state.identityModuleStates = map;
    renderSidebarIdentityList();
  } catch (err) {
    console.warn("[mini-web] loadIdentityModuleStates:", err);
  }
}

async function loadIdentityPatches() {
  const payload = await fetchJson("/api/state-patches?scope=identity_profile");
  state.identityPatches = payload.state || [];
  renderIdentitySnapshot();
  return state.identityPatches;
}

async function loadDiscoveredBots() {
  try {
    const payload = await fetchJson("/api/discovered-bots");
    state.discoveredBots = payload.discovered || [];
    updateGlobalBanner();
  } catch (error) {
    console.warn("[mini-web] loadDiscoveredBots failed:", error);
  }
}

function currentGameBotIds() {
  return new Set(((state.settings && state.settings.game_bot_ids) || []).map((x) => Number(x)));
}

function updateGlobalBanner() {
  if (!globalBanner) return;
  const ids = currentGameBotIds();
  if (ids.size === 0) {
    globalBanner.hidden = false;
    globalBanner.innerHTML = `
      <span><strong>未设置游戏 Bot</strong> — 现在系统消息(韩天尊)和玩家消息会混在一起,无法区分。</span>
      <button type="button" id="bannerOpenGameBots">去设置</button>
    `;
    globalBanner.querySelector("#bannerOpenGameBots")?.addEventListener("click", () => openGameBotsModal());
  } else {
    globalBanner.hidden = true;
    globalBanner.innerHTML = "";
  }
}

function openGameBotsModal() {
  const settings = state.settings || {};
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
        <p class="muted">这些是消息箱里 bot 类型 / 频道号 sender,而且**真的**发过包含游戏关键词(点卯/天梯/灵树/侍妾...)的消息。普通玩家闲聊不会被丢进来。点「+」加进上面输入框。</p>
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
  bindGameBotsModal(dialog);
  // 加载 discovered 列表
  fetchJson("/api/discovered-bots")
    .then((payload) => {
      state.discoveredBots = payload.discovered || [];
      renderGameBotsDiscoveredList(dialog);
    })
    .catch((error) => console.warn("[mini-web] discovered-bots fetch failed:", error));
}

function renderGameBotsDiscoveredList(dialog) {
  const list = dialog.querySelector("#gameBotsDiscoveredList");
  const input = dialog.querySelector("#gameBotsInput");
  if (!list || !input) return;
  const items = state.discoveredBots || [];
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
      renderGameBotsDiscoveredList(dialog);
    });
  });
}

function bindGameBotsModal(dialog) {
  const input = dialog.querySelector("#gameBotsInput");
  const saveBtn = dialog.querySelector("#gameBotsSaveBtn");
  const status = dialog.querySelector("#gameBotsStatus");
  if (input) {
    input.addEventListener("input", () => renderGameBotsDiscoveredList(dialog));
  }
  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const raw = (input?.value || "").replace(/，/g, ",");
      const tokens = raw.split(",").map((s) => s.trim()).filter(Boolean);
      const parsed = [];
      const bad = [];
      const seen = new Set();
      for (const tok of tokens) {
        const n = Number(tok);
        if (!Number.isFinite(n) || n === 0) {
          bad.push(tok);
          continue;
        }
        if (seen.has(n)) continue;
        seen.add(n);
        parsed.push(n);
      }
      if (bad.length) {
        status.hidden = false;
        status.className = "modal-status-line error";
        status.textContent = `不合法的 ID:${bad.join(", ")} (要非零整数)`;
        return;
      }
      saveBtn.disabled = true;
      status.hidden = false;
      status.className = "modal-status-line info";
      status.textContent = "正在保存…";
      try {
        const settings = state.settings || (await loadSettings());
        await postJson("/api/settings", {
          ...settings,
          api_hash: "",
          proxy_password: "",
          game_bot_ids: parsed.sort((a, b) => a - b),
        });
        state.settings = await loadSettings();
        status.className = "modal-status-line ok";
        status.textContent = `已保存 ${parsed.length} 条游戏 Bot ID`;
        updateGlobalBanner();
        setTimeout(() => closeModal(), 600);
      } catch (error) {
        status.className = "modal-status-line error";
        status.textContent = error.message || "保存失败";
        saveBtn.disabled = false;
      }
    });
  }
}

async function loadListenerStatus() {
  const payload = await fetchJson("/api/listener/status");
  return payload.listener;
}

async function loadTelegramDialogs() {
  const payload = await fetchJson("/api/telegram/dialogs");
  if (!payload.ok) {
    throw new Error(payload.error || "读取群 / 频道失败");
  }
  state.telegramDialogs = payload.dialogs || [];
  return state.telegramDialogs;
}

async function loadTelegramTopics(chat) {
  const payload = await fetchJson(`/api/telegram/topics?chat=${encodeURIComponent(chat || "")}`);
  if (!payload.ok) {
    throw new Error(payload.error || "读取话题失败");
  }
  state.telegramTopics = payload.topics || [];
  return state.telegramTopics;
}

async function saveSettings(payload) {
  const response = await apiFetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`保存失败：${response.status}`);
  }
  const data = await response.json();
  state.settings = data.settings;
  return data.settings;
}

async function saveAccount(payload) {
  const data = await postJson("/api/accounts", payload);
  if (!data.ok) {
    throw new Error(data.error || "保存账号失败");
  }
  await loadAccounts();
  return data.account;
}

async function saveIdentity(payload) {
  const data = await postJson("/api/identities", payload);
  if (!data.ok) {
    throw new Error(data.error || "保存身份失败");
  }
  await loadIdentities();
  return data.identity;
}

async function planOutboxAction(action) {
  const data = await postJson("/api/outbox/plan", { action });
  state.outboxPlan = data;
  return data;
}

function visibleMessages() {
  if (state.selectedChannels.size === 0) {
    return [];
  }
  // solo 模式数据已由 server 端 SQL 预过滤(mode=solo);前端只做频道过滤。
  // 「日志」modal 是另一条单独的全量数据流,不走这里。
  return state.messages.filter((message) => {
    const channels = message.channels || [message.channel];
    return channels.some((channel) => state.selectedChannels.has(channel));
  });
}

function myIdSet() {
  const set = new Set();
  for (const identity of state.identities || []) {
    const id = Number(identity.send_as_id || 0);
    if (id) set.add(id);
  }
  for (const account of state.accounts || []) {
    const id = Number(account.account_id || 0);
    if (id) set.add(id);
  }
  return set;
}

function botIdSet() {
  const ids = ((state.settings || {}).game_bot_ids) || [];
  return new Set(ids.map((id) => Number(id)).filter(Boolean));
}

function parentMessageOf(card) {
  if (!card.reply_to_msg_id || !card.chat_id) return null;
  const parentId = `tg:${card.chat_id}:${card.reply_to_msg_id}`;
  return state.messages.find((m) => m.id === parentId) || null;
}

function jumpToMessage(target) {
  if (!target) return;
  state.detailMode = "message";
  state.selectedMessageId = target.id;

  // 如果父消息在当前频道/模式过滤下隐藏了,放开过滤让它能露出来,
  // 否则点完没反应,用户以为跳转坏了。
  let needsRerender = false;
  const channels = target.channels || [target.channel];
  const channelInSelection = channels.some((ch) => state.selectedChannels.has(ch));
  if (!channelInSelection) {
    channels.forEach((ch) => state.selectedChannels.add(ch));
    renderChannelFilters();
    needsRerender = true;
  }
  if (state.viewMode === "solo") {
    // 跳转目标在 solo(server 端 SQL 过滤)里没有 → 提示用户去日志找。
    // 不再 silently 切「全部」,因为主界面只有 solo,没有「全部」按钮可以反映状态。
    const visibleAfter = visibleMessages().some((m) => m.id === target.id);
    if (!visibleAfter) {
      console.info("[mini-web] target not in solo view, open 日志 modal to see full chat");
      needsRerender = true;
    }
  }

  renderMessages();
  renderDetail();

  // DOM 重建完才去找节点;requestAnimationFrame 一下确保浏览器 layout 完
  window.requestAnimationFrame(() => {
    const node = messageList.querySelector(`[data-message-id="${CSS.escape(target.id)}"]`);
    if (!node) return;
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    // 闪一下让用户看见跳到哪了
    node.classList.add("highlight-jump");
    window.setTimeout(() => node.classList.remove("highlight-jump"), 1700);
  });
}

function renderReplyContext(message) {
  if (!message.reply_to_msg_id || !message.chat_id) return "";
  const parent = parentMessageOf(message);
  const parentId = `tg:${message.chat_id}:${message.reply_to_msg_id}`;
  if (parent) {
    const preview = (parent.raw || parent.summary || "").trim().replace(/\s+/g, " ").slice(0, 60) || "(无内容)";
    return `
      <div class="chat-reply-context" data-reply-jump="${escapeAttr(parentId)}" title="点击跳到原消息">
        <span class="arrow">↪</span>
        <span class="source">${escapeHtml(displaySource(parent.source))}</span>
        <span class="preview">${escapeHtml(preview)}</span>
      </div>
    `;
  }
  // 父消息不在当前 state(超出初始 200 条范围),仍可点击 — 点了会按需拉
  return `
    <div class="chat-reply-context" data-reply-jump="${escapeAttr(parentId)}" title="点击按需拉取并跳到原消息">
      <span class="arrow">↪</span>
      <span class="preview muted">回复消息 #${escapeHtml(String(message.reply_to_msg_id))}(点击载入)</span>
    </div>
  `;
}

async function fetchMessageById(id) {
  try {
    const params = new URLSearchParams({ id });
    const payload = await fetchJson(`/api/messages?${params.toString()}`);
    const card = (payload.messages || [])[0];
    if (!card) return null;
    // merge 进 state,后续重渲能看见
    const byId = new Map(state.messages.map((m) => [m.id, m]));
    byId.set(card.id, card);
    state.messages = Array.from(byId.values()).sort((a, b) => (b.seq || 0) - (a.seq || 0));
    return card;
  } catch (error) {
    console.warn("[mini-web] fetchMessageById failed:", error);
    return null;
  }
}

function renderChannelFilters() {
  const counts = channelMessageCounts();
  channelFilters.replaceChildren(
    ...state.channels.map((channel) => {
      const button = document.createElement("button");
      button.type = "button";
      const isActive = state.selectedChannels.has(channel.key);
      button.className = "channel-chip" + (isActive ? " active" : "");
      button.title = channel.description || channel.label;
      button.dataset.channelKey = channel.key;
      const count = counts.get(channel.key) || 0;
      button.innerHTML = `
        <span class="channel-chip-dot" aria-hidden="true"></span>
        <span class="channel-chip-label">${escapeHtml(channel.label)}</span>
        <span class="channel-chip-count">${count}</span>
      `;
      button.addEventListener("click", () => {
        if (state.selectedChannels.has(channel.key)) {
          state.selectedChannels.delete(channel.key);
        } else {
          state.selectedChannels.add(channel.key);
        }
        if (!visibleMessages().some((message) => message.id === state.selectedMessageId)) {
          state.selectedMessageId = visibleMessages()[0]?.id ?? null;
        }
        state.detailMode = "message";
        renderChannelFilters();
        renderMessages();
        renderDetail();
      });
      return button;
    })
  );

  selectAllChannels.textContent =
    state.selectedChannels.size === state.channels.length ? "清空" : "全选";
  renderActiveChannelText();
}

function channelMessageCounts() {
  const counts = new Map();
  for (const channel of state.channels) {
    counts.set(channel.key, 0);
  }
  for (const message of state.messages) {
    const keys = message.channels && message.channels.length ? message.channels : [message.channel];
    for (const key of keys) {
      if (counts.has(key)) {
        counts.set(key, counts.get(key) + 1);
      }
    }
  }
  return counts;
}

function renderIdentitySnapshot() {
  if (!identitySnapshot) {
    return;
  }
  const map = new Map((state.identityPatches || []).map((item) => [item.key, item]));
  const primaryTitle =
    map.get("境界")?.value ||
    map.get("灵根")?.value ||
    "未识别角色";
  const rows = ["境界", "宗门", "灵根", "综合战力"]
    .filter((key) => map.has(key))
    .map((key) => {
      const item = map.get(key);
      return `
        <div>
          <span>${escapeHtml(key)}</span>
          <strong>${escapeHtml(item.value)}</strong>
        </div>
      `;
    })
    .join("");
  const updatedAt = [...map.values()].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0]?.updated_at || "";
  identitySnapshot.innerHTML = `
    <button class="role-button active" type="button">
      <span>${escapeHtml(updatedAt ? `更新 ${updatedAt}` : "等待消息箱投影")}</span>
      <strong>${escapeHtml(primaryTitle)}</strong>
    </button>
    <div class="snapshot-grid">
      ${rows || '<p class="empty inline">暂无角色状态。发送或监听“我的灵根 / 战力”后会更新。</p>'}
    </div>
  `;
}

function renderActiveChannelText() {
  if (state.selectedChannels.size === 0) {
    activeChannelText.textContent = "未选择频道";
    return;
  }
  if (state.selectedChannels.size === state.channels.length) {
    activeChannelText.textContent = "全部频道";
    return;
  }
  const labels = state.channels
    .filter((channel) => state.selectedChannels.has(channel.key))
    .map((channel) => channel.label);
  activeChannelText.textContent = labels.join(" / ");
}

function renderMessages() {
  const messages = visibleMessages();
  const collectorStatus = collectorLiveStatus();
  messageCount.textContent = `${messages.length} 条${collectorStatus ? `｜${collectorStatus}` : ""}`;
  renderActiveChannelText();

  if (messages.length === 0) {
    messageList.innerHTML = `<div class="chat-empty">${escapeHtml(emptyMessageHint())}</div>`;
    return;
  }

  // 保住滚动位置,polling 重建 DOM 后不再「自己动」:
  // - 用户在顶部(看最新) → 重建后还在顶部
  // - 用户滚下去看旧消息 → 用 scrollHeight 差值补偿,视觉上看到的内容不动
  const prevScrollTop = messageList.scrollTop;
  const prevScrollHeight = messageList.scrollHeight;
  const nearTop = prevScrollTop <= 64;

  const groups = groupMessagesByDate(messages);
  const fragment = document.createDocumentFragment();
  groups.forEach((group) => {
    const divider = document.createElement("div");
    divider.className = "chat-day-divider";
    divider.innerHTML = `<span>${escapeHtml(group.label)}</span>`;
    fragment.appendChild(divider);
    group.items.forEach((message) => {
      fragment.appendChild(renderChatMessageNode(message));
    });
  });
  messageList.replaceChildren(fragment);

  if (nearTop) {
    messageList.scrollTop = 0;
  } else {
    const heightDelta = messageList.scrollHeight - prevScrollHeight;
    messageList.scrollTop = prevScrollTop + (heightDelta > 0 ? heightDelta : 0);
  }
}

function emptyMessageHint() {
  if (state.channels.length === 0) {
    return "还没有从 Telegram 收到消息。先在「配置 Telegram 接入」里完成登录,然后让监听账号开始采集。";
  }
  if (state.selectedChannels.size === 0) {
    return "在左侧勾选要查看的频道,消息会按时间排到这里。";
  }
  if (state.messages.length === 0) {
    return "消息箱当前还是空的。监听跑起来后,新消息会落到这里。";
  }
  return "当前频道筛选下没有消息。可以多勾几个频道,或点右上角刷新。";
}

function collectorLiveStatus() {
  const running = state.listenerSummary?.running || {};
  const collectorKey = state.listenerSummary?.collector || "";
  if (!collectorKey) {
    return "未采集";
  }
  const status = String(running[collectorKey]?.status || "");
  if (status === "running") return "采集中";
  if (status === "starting") return "采集启动中";
  if (status === "reconnecting") return "采集重连中";
  if (status === "stopping") return "采集停止中";
  if (status === "error") return "采集出错";
  return "未采集";
}

function renderChatMessageNode(message) {
  const row = document.createElement("article");
  const kind = messageKind(message);
  const isExpanded = state.expandedMessages.has(message.id);
  row.className = [
    "chat-message",
    `kind-${kind}`,
    message.id === state.selectedMessageId ? "active" : "",
  ]
    .filter(Boolean)
    .join(" ");
  row.dataset.messageId = message.id;

  const channels = (message.channels || [message.channel])
    .map((channel) => `<span class="chat-channel-pill">${escapeHtml(channelLabel(channel))}</span>`)
    .join("");
  const tags = (message.tags || []).map((tag) => `<span class="chat-tag">${escapeHtml(tag)}</span>`).join("");
  const actionCount = (message.actions || []).length;
  const enhanceItems = [
    message.title ? `<span class="chat-title-pill">${escapeHtml(message.title)}</span>` : "",
    tags,
    actionCount ? `<span class="chat-action-pill">${actionCount} 个动作草稿</span>` : "",
  ]
    .filter(Boolean)
    .join("");

  const { html: textHtml, truncated } = renderChatBodyText(message, isExpanded);
  const riskBadge =
    kind === "risk"
      ? `<span class="chat-risk-badge" title="风险消息，需要人工查看">! 需要关注</span>`
      : "";
  const sourceText = displaySource(message.source);
  const sourceClass = isNumericSource(message.source) ? "chat-source numeric" : "chat-source";
  const replyContext = renderReplyContext(message);

  row.innerHTML = `
    <button type="button" class="chat-avatar-btn" data-chat-action="select" aria-label="查看消息详情">
      <span class="chat-avatar" aria-hidden="true">${escapeHtml(sourceInitial(message.source, kind))}</span>
    </button>
    <div class="chat-body">
      <button type="button" class="chat-head" data-chat-action="select">
        <strong class="${sourceClass}">${escapeHtml(sourceText)}</strong>
        <span class="chat-time">${escapeHtml(formatChatTime(message.time))}</span>
        <span class="chat-channels">${channels}</span>
        ${riskBadge}
      </button>
      ${replyContext}
      <div class="chat-text" data-chat-action="select">${textHtml}</div>
      ${truncated ? `<button type="button" class="chat-toggle" data-chat-action="toggle">${isExpanded ? "收起全文" : "展开全文"}</button>` : ""}
      ${enhanceItems ? `<div class="chat-enhance">${enhanceItems}</div>` : ""}
    </div>
  `;

  row.addEventListener("click", async (event) => {
    const toggle = event.target.closest('[data-chat-action="toggle"]');
    if (toggle) {
      event.stopPropagation();
      if (state.expandedMessages.has(message.id)) {
        state.expandedMessages.delete(message.id);
      } else {
        state.expandedMessages.add(message.id);
      }
      renderMessages();
      return;
    }
    const jump = event.target.closest("[data-reply-jump]");
    if (jump) {
      event.stopPropagation();
      const targetId = jump.dataset.replyJump;
      let parent = state.messages.find((m) => m.id === targetId);
      if (!parent) {
        // 不在 state 里,按需拉一条进来
        jump.classList.add("loading");
        parent = await fetchMessageById(targetId);
        jump.classList.remove("loading");
        if (!parent) {
          console.warn("[mini-web] 父消息不存在或已被清理:", targetId);
          return;
        }
      }
      jumpToMessage(parent);
      return;
    }
    state.detailMode = "message";
    state.selectedMessageId = message.id;
    renderMessages();
    renderDetail();
  });
  return row;
}

function displaySource(source) {
  const clean = String(source || "").trim();
  if (!clean) {
    return "未知发送者";
  }
  if (isNumericSource(clean)) {
    return `用户 ${clean}`;
  }
  return clean;
}

function isNumericSource(source) {
  const clean = String(source || "").trim();
  return clean !== "" && NUMERIC_SOURCE_RE.test(clean);
}

function renderChatBodyText(message, isExpanded) {
  const raw = String(message.raw || "").trim();
  const fallback = String(message.summary || message.title || "").trim();
  const text = raw || fallback || "（空消息）";
  const lines = text.split("\n");
  const tooLong =
    text.length > MESSAGE_PREVIEW_CHAR_LIMIT || lines.length > MESSAGE_PREVIEW_LINE_LIMIT;

  if (!tooLong || isExpanded) {
    return { html: escapeHtml(text), truncated: tooLong };
  }

  const previewLines = lines.slice(0, MESSAGE_PREVIEW_LINE_LIMIT);
  let preview = previewLines.join("\n");
  if (preview.length > MESSAGE_PREVIEW_CHAR_LIMIT) {
    preview = preview.slice(0, MESSAGE_PREVIEW_CHAR_LIMIT);
  }
  return { html: `${escapeHtml(preview)}<span class="chat-text-ellipsis">…</span>`, truncated: true };
}

function groupMessagesByDate(messages) {
  const groups = [];
  let current = null;
  messages.forEach((message) => {
    const label = formatDayLabel(message.time);
    if (!current || current.label !== label) {
      current = { label, items: [] };
      groups.push(current);
    }
    current.items.push(message);
  });
  return groups;
}

function formatDayLabel(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "时间未知";
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return text;
  }
  const now = new Date();
  const diffDays = daysBetween(date, now);
  if (diffDays === 0) {
    return "今天";
  }
  if (diffDays === 1) {
    return "昨天";
  }
  if (diffDays === 2) {
    return "前天";
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  }
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
}

function daysBetween(date, now) {
  const a = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function formatChatTime(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return text;
  }
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function messageKind(message) {
  const channels = message.channels || [message.channel];
  const source = String(message.source || "");
  if (message.severity === "risk" || channels.includes("risk")) {
    return "risk";
  }
  if (channels.includes("mine")) {
    return "mine";
  }
  if (message.sender_is_bot || channels.includes("system") || source.includes("韩天尊") || source.includes("天尊")) {
    return "bot";
  }
  return "player";
}

function sourceInitial(source, kind) {
  const clean = String(source || "").replace(/^@/, "").trim();
  if (kind === "risk") {
    return "！";
  }
  if (clean.includes("韩天尊") || clean.includes("天尊")) {
    return "天";
  }
  if (!clean) {
    return "?";
  }
  return clean.slice(0, 1).toUpperCase();
}

function renderDetail() {
  const message = state.messages.find((item) => item.id === state.selectedMessageId);
  if (!message || !visibleMessages().some((item) => item.id === message.id)) {
    detailState.textContent = "未选择";
    detailPanel.innerHTML = '<p class="empty">从左边选择一条消息，可以看到 Telegram 原文与可用动作草稿。</p>';
    return;
  }

  const isRisk = message.severity === "risk";
  detailState.textContent = isRisk ? "风险" : "已选择";
  const channelPills = (message.channels || [message.channel])
    .map((channel) => `<span class="channel-pill">${escapeHtml(channelLabel(channel))}</span>`)
    .join("");
  const tagPills = (message.tags || [])
    .map((tag) => `<span>${escapeHtml(tag)}</span>`)
    .join("");
  const enhancedHtml = renderEnhancedBlock(message);
  const actionsHtml = renderDetailActions(message);
  const heading = String(message.title || "").trim() || "Telegram 消息";
  const summary = String(message.summary || "").trim();

  detailPanel.innerHTML = `
    <div class="detail-block detail-summary ${isRisk ? "risk" : ""}">
      <div class="detail-summary-head">
        <h4>${escapeHtml(heading)}</h4>
        <span class="detail-time">${escapeHtml(message.time || "时间未知")}</span>
      </div>
      <div class="detail-source">
        <span>${escapeHtml(displaySource(message.source))}</span>
        <div class="detail-channels">${channelPills}</div>
      </div>
      ${summary ? `<p>${escapeHtml(summary)}</p>` : ""}
      ${tagPills ? `<div class="tag-row">${tagPills}</div>` : ""}
      ${isRisk ? `<p class="detail-risk-hint">这是一条风险类消息，请人工查看原文后再决定如何回应。</p>` : ""}
    </div>

    <div class="detail-block">
      <h5>Telegram 原文</h5>
      <pre class="raw-text">${escapeHtml(message.raw || "（未抓取到原文）")}</pre>
    </div>

    <div class="detail-block">
      <h5>增强字段</h5>
      ${enhancedHtml}
    </div>

    <div class="detail-block">
      <h5>动作草稿</h5>
      ${actionsHtml}
      <div id="outboxPlanPanel" class="outbox-plan-wrap"></div>
    </div>
  `;

  bindDetailActions(message);
}

// 卡片专用 renderer 注册表 — 按 message.title 派发,落不到具体 renderer 就走通用 fields grid。
// 新增「页游化」卡片只需在这里加一行 + 写对应 render 函数。
const cardRenderers = {
  "战力评估": renderBattlePowerCard,
  "角色信息": renderProfileCard,
  "深度闭关总结": renderDeepRetreatSummaryCard,
  "闭关成功": renderRetreatSuccessCard,
  "试炼古塔战报": renderTowerTrialCard,
};

function renderEnhancedBlock(message) {
  const title = String(message.title || "").trim();
  const renderer = cardRenderers[title];
  if (renderer) {
    try {
      return renderer(message);
    } catch (err) {
      console.warn("[card-render]", title, err);
      // 渲染器自己挂了,退回 fields grid,别让整面板白屏
      return renderDetailFields(message.fields);
    }
  }
  return renderDetailFields(message.fields);
}

function richHero(icon, label, value) {
  return `
    <div class="rich-hero">
      <div class="rich-hero-icon">${icon}</div>
      <div class="rich-hero-text">
        <span class="rich-hero-label">${escapeHtml(label)}</span>
        <strong class="rich-hero-value">${escapeHtml(value)}</strong>
      </div>
    </div>
  `;
}

function richChips(pairs) {
  // pairs: [["灵根", "天灵根(火)"], ...]
  const html = pairs
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(([k, v]) => `<span class="rich-chip"><span class="rich-chip-k">${escapeHtml(k)}</span>${escapeHtml(String(v))}</span>`)
    .join("");
  return html ? `<div class="rich-chips">${html}</div>` : "";
}

function renderBattlePowerCard(message) {
  const f = message.fields || {};
  const power = f["综合战力"] ? formatFieldValue(f["综合战力"]) : "—";
  const realm = f["境界"] ? formatFieldValue(f["境界"]) : "未知";
  return `
    <div class="card-rich card-rich-stat">
      ${richHero("⚔️", "综合战力", power)}
      ${richChips([["境界", realm]])}
    </div>
  `;
}

function renderProfileCard(message) {
  const f = message.fields || {};
  const root = f["灵根"] ? formatFieldValue(f["灵根"]) : "—";
  const sect = f["宗门"] ? formatFieldValue(f["宗门"]) : "散修";
  const owner = String(message.source || "").trim() || "本尊";
  return `
    <div class="card-rich card-rich-profile">
      ${richHero("📜", "天命玉牒", owner)}
      ${richChips([["灵根", root], ["宗门", sect]])}
    </div>
  `;
}

function richStatGrid(pairs) {
  // pairs: [["修行有成","22 次"], ...]
  const cells = pairs
    .filter(([, v]) => v != null && String(v).trim() !== "")
    .map(
      ([k, v]) => `
        <div class="rich-stat-cell">
          <span class="rich-stat-cell-k">${escapeHtml(k)}</span>
          <span class="rich-stat-cell-v">${escapeHtml(String(v))}</span>
        </div>`
    )
    .join("");
  return cells ? `<div class="rich-stat-grid">${cells}</div>` : "";
}

function richCollapsibleList(label, items, maxVisible = 4) {
  if (!Array.isArray(items) || items.length === 0) return "";
  const head = items.slice(0, maxVisible);
  const tail = items.slice(maxVisible);
  const headHtml = head.map((it) => `<li>${escapeHtml(String(it))}</li>`).join("");
  const tailHtml = tail.length
    ? `<ul class="rich-list rich-list-collapsed" hidden>${tail
        .map((it) => `<li>${escapeHtml(String(it))}</li>`)
        .join("")}</ul>
       <button type="button" class="rich-collapse-toggle" data-rich-collapse="1">展开剩余 ${tail.length} 条</button>`
    : "";
  return `
    <div class="rich-progress">
      <div class="rich-progress-head"><span>${escapeHtml(label)}</span></div>
      <ul class="rich-list">${headHtml}</ul>
      ${tailHtml}
    </div>
  `;
}

function richProgress(label, current, max, suffix = "") {
  const c = Number(current) || 0;
  const m = Number(max) || 0;
  const pct = m > 0 ? Math.min(100, Math.max(0, (c / m) * 100)) : 0;
  return `
    <div class="rich-progress">
      <div class="rich-progress-head">
        <span>${escapeHtml(label)}</span>
        <span>${escapeHtml(`${c} / ${m}${suffix ? " " + suffix : ""}`)}</span>
      </div>
      <div class="rich-progress-bar"><span class="rich-progress-fill" style="width:${pct.toFixed(1)}%"></span></div>
    </div>
  `;
}

function renderDeepRetreatSummaryCard(message) {
  const f = message.fields || {};
  const gain = f["修为变化"] ? formatFieldValue(f["修为变化"]) : "—";
  return `
    <div class="card-rich card-rich-summary">
      ${richHero("📿", "深度闭关 · 修为变化", gain)}
      ${richStatGrid([
        ["结算时长", f["结算时长"] || ""],
        ["神魂吐纳", f["神魂吐纳"] || ""],
        ["修行有成", f["修行有成"] || ""],
        ["心神不宁", f["心神不宁"] || ""],
        ["走火入魔", f["走火入魔"] || ""],
        ["天降奇遇", f["天降奇遇"] || ""],
      ])}
      ${f["状态加持"] ? `<div class="rich-chips"><span class="rich-chip"><span class="rich-chip-k">状态加持</span>${escapeHtml(String(f["状态加持"]))}</span></div>` : ""}
      ${richCollapsibleList("奇遇详情", f["奇遇详情"] || [], 4)}
    </div>
  `;
}

function renderRetreatSuccessCard(message) {
  const f = message.fields || {};
  const total = f["本次总收益"] ? formatFieldValue(f["本次总收益"]) : "—";
  const realm = f["当前境界"] ? formatFieldValue(f["当前境界"]) : "";
  const cooldown = f["调息冷却"] ? formatFieldValue(f["调息冷却"]) : "";
  const progress = f["修为进度"] && typeof f["修为进度"] === "object" ? f["修为进度"] : null;
  return `
    <div class="card-rich card-rich-summary">
      ${richHero("🧘", "本次总收益", total)}
      ${richStatGrid([
        ["基础修为", f["基础修为"] || ""],
        ["灵脉加成", f["灵脉加成"] || ""],
        ["阵法加成", f["阵法加成"] || ""],
        ["当前境界", realm],
        ["调息冷却", cooldown],
      ])}
      ${progress ? richProgress("当前修为", progress.current, progress.max) : ""}
      ${f["奇遇"] ? `<div class="rich-chips"><span class="rich-chip"><span class="rich-chip-k">奇遇</span>${escapeHtml(String(f["奇遇"]))}</span></div>` : ""}
    </div>
  `;
}

function renderTowerTrialCard(message) {
  const f = message.fields || {};
  const floors = f["闯过层数"] ? formatFieldValue(f["闯过层数"]) : "—";
  const detailFloors = Array.isArray(f["逐层详情"]) ? f["逐层详情"] : [];
  const floorRows = detailFloors
    .map((fl) => {
      const outcome = String(fl.outcome || "");
      const cls = outcome === "败北" ? "out-fail" : outcome === "险胜" ? "out-win" : "out-crush";
      return `<li><span class="tower-floor-num">第 ${escapeHtml(String(fl.floor))} 层</span> <span class="tower-floor-realm">${escapeHtml(String(fl.realm))} / ${escapeHtml(String(fl.kind))}</span> <span class="tower-floor-outcome ${cls}">${escapeHtml(outcome)}</span></li>`;
    })
    .join("");
  return `
    <div class="card-rich card-rich-tower">
      ${richHero("⚔️", "试炼古塔 · 闯过", floors)}
      ${richStatGrid([
        ["修为增长", f["修为增长"] || ""],
        ["塔印", f["塔印"] || ""],
        ["同境界超过", f["同境界超过"] || ""],
      ])}
      ${f["本次构筑"] ? `<div class="rich-chips"><span class="rich-chip"><span class="rich-chip-k">构筑</span>${escapeHtml(String(f["本次构筑"]))}</span></div>` : ""}
      ${f["塔相轨迹"] ? `<div class="rich-chips"><span class="rich-chip"><span class="rich-chip-k">塔相</span>${escapeHtml(String(f["塔相轨迹"]))}</span></div>` : ""}
      ${f["触发奇遇"] ? `<div class="rich-chips"><span class="rich-chip"><span class="rich-chip-k">奇遇</span>${escapeHtml(String(f["触发奇遇"]))}</span></div>` : ""}
      ${f["遭遇词缀"] ? `<div class="rich-chips"><span class="rich-chip"><span class="rich-chip-k">词缀</span>${escapeHtml(String(f["遭遇词缀"]))}</span></div>` : ""}
      ${richCollapsibleList("收获", f["收获列表"] || [], 4)}
      ${floorRows ? `<div class="rich-progress"><div class="rich-progress-head"><span>逐层概要</span></div><ul class="tower-floor-list">${floorRows}</ul></div>` : ""}
    </div>
  `;
}

function renderDetailFields(fields) {
  const entries = Object.entries(fields || {}).filter(([, value]) => isPresentValue(value));
  if (entries.length === 0) {
    return '<p class="empty inline">解析器没有从这条消息中识别出结构化字段,可以直接看 Telegram 原文。</p>';
  }
  const items = entries
    .map(
      ([key, value]) => `
        <div>
          <span>${escapeHtml(key)}</span>
          <strong>${escapeHtml(formatFieldValue(value))}</strong>
        </div>
      `
    )
    .join("");
  return `<div class="field-grid">${items}</div>`;
}

function isPresentValue(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string" && value.trim() === "") {
    return false;
  }
  if (Array.isArray(value) && value.length === 0) {
    return false;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

function formatFieldValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => formatFieldValue(item)).join("、");
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, v]) => isPresentValue(v))
      .map(([k, v]) => `${k}：${formatFieldValue(v)}`)
      .join("，");
  }
  return String(value);
}

function renderDetailActions(message) {
  const actions = message.actions || [];
  if (actions.length === 0) {
    return '<p class="empty inline">这条消息没有解析出可复制 / 可入队的命令草稿。如果你想自己拼命令,可以参考 Telegram 原文。</p>';
  }
  const cards = actions
    .map((action, index) => {
      const context = renderActionContextLine(action);
      const notice = state.draftNoticeByMessageId.get(`${message.id}:${index}`);
      return `
        <div class="action-draft" data-action-index="${index}">
          <div class="action-draft-head">
            <strong>${escapeHtml(action.label || "动作")}</strong>
            ${context ? `<small>${escapeHtml(context)}</small>` : ""}
          </div>
          <code class="action-draft-command">${escapeHtml(action.command)}</code>
          <div class="action-draft-buttons">
            <button type="button" class="action-primary" data-action-button="copy" data-action-index="${index}">复制命令</button>
            <button type="button" class="action-secondary" data-action-button="enqueue" data-action-index="${index}">确认入队</button>
            <button type="button" class="action-tertiary" data-action-button="plan" data-action-index="${index}">查看发送计划</button>
          </div>
          ${notice ? `<p class="action-draft-notice ${notice.kind}">${escapeHtml(notice.text)}</p>` : ""}
        </div>
      `;
    })
    .join("");
  return `<div class="action-list">${cards}</div>`;
}

function renderActionContextLine(action) {
  const parts = [];
  if (action.chat_id !== undefined && action.chat_id !== null) {
    parts.push(`群 ${action.chat_id}`);
  }
  if (action.reply_to_msg_id !== undefined && action.reply_to_msg_id !== null) {
    parts.push(`回复 ${action.reply_to_msg_id}`);
  }
  if (action.identity_id !== undefined && action.identity_id !== null) {
    parts.push(`身份 ${action.identity_id}`);
  }
  if (action.account_local_id) {
    parts.push(`账号 ${action.account_local_id}`);
  }
  return parts.join("｜");
}

function bindDetailActions(message) {
  const actions = message.actions || [];
  detailPanel.querySelectorAll('[data-rich-collapse="1"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const list = btn.previousElementSibling;
      if (!list) return;
      const hidden = list.hasAttribute("hidden");
      if (hidden) {
        list.removeAttribute("hidden");
        btn.textContent = "收起";
      } else {
        list.setAttribute("hidden", "");
        btn.textContent = `展开剩余 ${list.children.length} 条`;
      }
    });
  });
  detailPanel.querySelectorAll("[data-action-button]").forEach((button) => {
    button.addEventListener("click", async () => {
      const index = Number(button.dataset.actionIndex || 0);
      const action = actions[index];
      if (!action) {
        return;
      }
      const kind = button.dataset.actionButton;
      const planPanel = detailPanel.querySelector("#outboxPlanPanel");
      const noticeKey = `${message.id}:${index}`;
      try {
        if (kind === "copy") {
          await copyCommandToClipboard(action.command, button);
          return;
        }
        if (kind === "plan") {
          button.disabled = true;
          const plan = await planOutboxAction(action);
          renderOutboxPlan(plan, action, planPanel);
          return;
        }
        if (kind === "enqueue") {
          button.disabled = true;
          const result = await createOutboxDraft(action, message.id);
          if (result.ok && result.draft) {
            state.draftNoticeByMessageId.set(noticeKey, {
              kind: "ok",
              text: `已入队草稿 ${result.draft.id || ""}，可在草稿箱里人工确认或删除。`,
            });
          } else {
            state.draftNoticeByMessageId.set(noticeKey, {
              kind: "warn",
              text: result.error || "入队草稿失败",
            });
          }
          renderDetail();
          return;
        }
      } catch (error) {
        if (kind === "plan") {
          renderOutboxPlanError(error, planPanel);
        } else {
          state.draftNoticeByMessageId.set(noticeKey, {
            kind: "warn",
            text: error.message || "操作失败",
          });
          renderDetail();
        }
      } finally {
        if (kind !== "copy") {
          button.disabled = false;
        }
      }
    });
  });
}

async function copyCommandToClipboard(command, button) {
  try {
    await navigator.clipboard.writeText(command);
    const original = button.textContent;
    button.textContent = "已复制";
    button.classList.add("copied");
    setTimeout(() => {
      button.textContent = original;
      button.classList.remove("copied");
    }, 1200);
  } catch (error) {
    button.textContent = "复制失败";
  }
}

async function createOutboxDraft(action, sourceMessageId) {
  return postJson("/api/outbox/drafts", {
    action,
    source_message_id: sourceMessageId,
  }).catch((error) => ({ ok: false, error: error.message }));
}

async function deleteOutboxDraft(draftId) {
  return postJson("/api/outbox/drafts/delete", { id: draftId }).catch((error) => ({
    ok: false,
    error: error.message,
  }));
}

async function renderOutboxDraftsView() {
  state.detailMode = "drafts";
  detailState.textContent = "草稿箱";
  detailPanel.innerHTML = '<p class="empty">正在读取草稿箱…</p>';
  await loadOutboxDrafts();
  const drafts = state.outboxDrafts || [];
  if (drafts.length === 0) {
    detailPanel.innerHTML = `
      <div class="detail-block">
        <h4>草稿箱</h4>
        <p>当前没有等待人工确认的动作草稿。可以在某条消息的「动作草稿」区里点「确认入队」,把命令放进这里。</p>
      </div>
    `;
    return;
  }
  const items = drafts
    .map((draft) => {
      const status = draft.resolved ? "已解析" : "上下文未补齐";
      const statusClass = draft.resolved ? "ok" : "warn";
      const meta = [
        draft.target_chat ? `群 ${draft.target_chat}` : draft.chat_id ? `群 ${draft.chat_id}` : "",
        draft.identity_id ? `身份 ${draft.identity_id}` : "",
        draft.account_local_id ? `账号 ${draft.account_local_id}` : "",
        draft.reply_to_msg_id ? `回复 ${draft.reply_to_msg_id}` : "",
        draft.created_at ? `入队 ${draft.created_at}` : "",
      ]
        .filter(Boolean)
        .join("｜");
      return `
        <article class="draft-item" data-draft-id="${escapeAttr(draft.id)}">
          <div class="draft-head">
            <code class="draft-command">${escapeHtml(draft.command || "（空命令）")}</code>
            <span class="status-pill ${statusClass}">${escapeHtml(status)}</span>
          </div>
          ${meta ? `<p class="draft-meta">${escapeHtml(meta)}</p>` : ""}
          ${draft.source_message_id ? `<p class="draft-meta">来源 ${escapeHtml(draft.source_message_id)}</p>` : ""}
          <div class="draft-buttons">
            <button type="button" data-draft-action="copy">复制命令</button>
            <button type="button" data-draft-action="open" data-source-id="${escapeAttr(draft.source_message_id || "")}">查看原消息</button>
            <button type="button" class="danger" data-draft-action="delete">删除草稿</button>
          </div>
        </article>
      `;
    })
    .join("");
  detailPanel.innerHTML = `
    <div class="detail-block">
      <div class="draft-head-row">
        <h4>草稿箱</h4>
        <span>${drafts.length} 条等待人工确认</span>
      </div>
      <p>这些是已经入队、等待你人工确认或删除的命令草稿。本工具不会自动发出去。</p>
      <div class="draft-list">${items}</div>
    </div>
  `;
  bindOutboxDraftButtons();
}

function bindOutboxDraftButtons() {
  detailPanel.querySelectorAll(".draft-item").forEach((article) => {
    const draftId = article.dataset.draftId;
    article.querySelectorAll("[data-draft-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.dataset.draftAction;
        const draft = state.outboxDrafts.find((item) => item.id === draftId);
        if (!draft) {
          return;
        }
        if (action === "copy") {
          await copyCommandToClipboard(draft.command || "", button);
          return;
        }
        if (action === "open") {
          const sourceId = button.dataset.sourceId;
          if (!sourceId) {
            return;
          }
          if (state.messages.some((message) => message.id === sourceId)) {
            state.detailMode = "message";
            state.selectedMessageId = sourceId;
            renderMessages();
            renderDetail();
          }
          return;
        }
        if (action === "delete") {
          if (!window.confirm("删除这条草稿?")) {
            return;
          }
          button.disabled = true;
          const result = await deleteOutboxDraft(draftId);
          if (result.ok) {
            await renderOutboxDraftsView();
          } else {
            button.disabled = false;
            window.alert(result.error || "删除失败");
          }
        }
      });
    });
  });
}

function channelLabel(key) {
  return state.channels.find((channel) => channel.key === key)?.label || key;
}

function renderOutboxPlan(plan, action, container) {
  if (!container) {
    return;
  }
  if (!plan.ok) {
    renderOutboxPlanError(new Error(plan.error || "发送计划生成失败"), container);
    return;
  }

  const missingText = (plan.missing || []).map(missingLabel).join("、");
  const statusText = plan.resolved ? "已解析" : `待补齐：${missingText || "上下文"}`;
  const statusClass = plan.resolved ? "ok" : "warn";
  container.innerHTML = `
    <div class="outbox-plan">
      <div class="outbox-plan-head">
        <h5>发送计划</h5>
        <span class="status-pill ${statusClass}">${escapeHtml(statusText)}</span>
      </div>
      <div class="plan-grid">
        <div><span>命令</span><code>${escapeHtml(plan.command)}</code></div>
        <div><span>目标</span><strong>${escapeHtml(planTargetLabel(plan))}</strong></div>
        <div><span>回复</span><strong>${escapeHtml(plan.reply_to_msg_id ?? "不回复特定消息")}</strong></div>
        <div><span>身份</span><strong>${escapeHtml(planIdentityLabel(plan))}</strong></div>
        <div><span>账号</span><strong>${escapeHtml(planAccountLabel(plan))}</strong></div>
        <div><span>发送</span><strong>${plan.can_send ? "可人工确认发送" : "仅复制/计划"}</strong></div>
      </div>
      <div class="plan-controls">
        <label>
          <span>改用身份</span>
          <select data-plan-field="identity_id">
            ${renderPlanIdentityOptions(plan.identity_id)}
          </select>
        </label>
        <label>
          <span>改用账号</span>
          <select data-plan-field="account_local_id">
            ${renderPlanAccountOptions(plan.account_local_id)}
          </select>
        </label>
      </div>
      <div class="form-actions outbox-actions">
        <button type="button" data-plan-action="copy">复制命令</button>
        <button type="button" data-plan-action="replan">重新解析</button>
      </div>
      <p>${escapeHtml(plan.note || "动作只生成手动计划，不会自动发送。")}</p>
    </div>
  `;
  bindOutboxPlanControls(container, action);
}

function renderOutboxPlanError(error, container) {
  if (!container) {
    return;
  }
  container.innerHTML = `
    <div class="outbox-plan">
      <div class="outbox-plan-head">
        <h5>发送计划</h5>
        <span class="status-pill risk">失败</span>
      </div>
      <p class="error">${escapeHtml(error.message)}</p>
    </div>
  `;
}

function bindOutboxPlanControls(container, action) {
  const copyButton = container.querySelector('[data-plan-action="copy"]');
  const replanButton = container.querySelector('[data-plan-action="replan"]');
  if (copyButton) {
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(action.command);
        copyButton.textContent = "已复制";
        setTimeout(() => {
          copyButton.textContent = "复制命令";
        }, 1200);
      } catch (error) {
        copyButton.textContent = "复制失败";
      }
    });
  }
  if (replanButton) {
    replanButton.addEventListener("click", async () => {
      replanButton.disabled = true;
      try {
        const nextAction = actionWithPlanOverrides(action, container);
        const plan = await planOutboxAction(nextAction);
        renderOutboxPlan(plan, nextAction, container);
      } catch (error) {
        renderOutboxPlanError(error, container);
      } finally {
        replanButton.disabled = false;
      }
    });
  }
}

function actionWithPlanOverrides(action, container) {
  const nextAction = { ...action };
  const identityValue = container.querySelector('[data-plan-field="identity_id"]')?.value || "";
  const accountValue = container.querySelector('[data-plan-field="account_local_id"]')?.value || "";
  if (identityValue) {
    nextAction.identity_id = Number(identityValue);
  } else {
    delete nextAction.identity_id;
  }
  if (accountValue) {
    nextAction.account_local_id = accountValue;
  } else {
    delete nextAction.account_local_id;
  }
  return nextAction;
}

function renderPlanIdentityOptions(selectedId) {
  const selected = selectedId !== undefined && selectedId !== null ? String(selectedId) : "";
  const options = state.identities
    .map((identity) => {
      const value = String(identity.send_as_id);
      const label = `${identity.label || identity.username || value}｜${value}`;
      return `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
  return `<option value="" ${selected ? "" : "selected"}>不指定身份</option>${options}`;
}

function renderPlanAccountOptions(selectedLocalId) {
  const selected = String(selectedLocalId || "");
  const options = state.accounts
    .map((account) => {
      const value = account.local_id;
      const label = `${account.label || value}｜${value}`;
      return `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
  return `<option value="" ${selected ? "" : "selected"}>按身份绑定/不指定</option>${options}`;
}

function missingLabel(key) {
  const labels = {
    identity: "身份",
    account: "发送账号",
    target_chat: "目标群",
  };
  return labels[key] || key;
}

function planTargetLabel(plan) {
  if (plan.chat_id !== undefined && plan.chat_id !== null) {
    return `群 ${plan.chat_id}`;
  }
  if (plan.target_chat) {
    return plan.target_chat;
  }
  return "未解析";
}

function planIdentityLabel(plan) {
  if (plan.identity) {
    return `${plan.identity.label || plan.identity.username || plan.identity.send_as_id}｜${plan.identity.send_as_id}`;
  }
  if (plan.identity_id !== undefined && plan.identity_id !== null) {
    return `未登记身份 ${plan.identity_id}`;
  }
  return "未指定";
}

function planAccountLabel(plan) {
  if (plan.account) {
    return `${plan.account.label || plan.account.local_id}｜${plan.account.local_id}`;
  }
  if (plan.account_local_id) {
    return `未保存账号 ${plan.account_local_id}`;
  }
  return "未指定";
}

function showError(error) {
  detailState.textContent = "错误";
  detailPanel.innerHTML = `<p class="error">${escapeHtml(error.message)}</p>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("\n", "&#10;");
}

function renderSettings(settings) {
  detailState.textContent = "接入配置";
  const botIds = (settings.game_bot_ids || []).join("\n");
  const savedSecrets = settings.saved_secrets || {};
  const dialogOptions = renderDialogOptions(settings.target_chat);
  const topicOptions = renderTopicOptions(settings.target_topic_id);
  const accountCount = state.accounts.length;
  const accountLimit = state.accountLimit || 0;
  const identityCount = state.identities.length;
  const identityLimit = state.identityLimit || 0;
  detailPanel.innerHTML = `
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
        ${renderAccountList()}
      </div>
    </div>
  `;

  loadListenerStatus()
    .then((listener) => {
      const target = document.querySelector("#listenerStatusText");
      if (target) {
        target.textContent = `监听状态：${listener.status} ${listener.message || ""}`;
      }
    })
    .catch(() => {});

  document.querySelector("#settingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const saved = await saveCurrentSettingsFromForm(event.currentTarget);
      state.settingsNotice = "配置已保存";
      renderSettings(saved);
      detailState.textContent = "已保存";
    } catch (error) {
      showError(error);
    }
  });

  detailPanel.querySelectorAll("[data-select-target]").forEach((select) => {
    select.addEventListener("change", () => {
      const form = document.querySelector("#settingsForm");
      const input = form.querySelector(`[name="${select.dataset.selectTarget}"]`);
      if (input) {
        input.value = select.value;
      }
      if (select.dataset.selectTarget === "target_chat") {
        state.telegramTopics = [];
        const topicInput = form.querySelector('[name="target_topic_id"]');
        const topicSelect = form.querySelector('[data-select-target="target_topic_id"]');
        if (topicInput && topicSelect) {
          topicInput.value = "";
          topicSelect.value = "";
        }
      }
    });
  });

  detailPanel.querySelectorAll("[data-telegram-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const form = document.querySelector("#settingsForm");
      button.disabled = true;
      try {
        await saveCurrentSettingsFromForm(form);
        if (button.dataset.telegramAction === "load-dialogs") {
          state.settingsNotice = "正在读取当前账号可见的群 / 频道...";
          await loadTelegramDialogs();
          state.settingsNotice = state.telegramDialogs.length
            ? `已读取 ${state.telegramDialogs.length} 个群 / 频道，请从下拉框选择。`
            : "没有读取到可用群 / 频道。";
        } else if (button.dataset.telegramAction === "load-topics") {
          const targetChat = new FormData(form).get("target_chat");
          if (!String(targetChat || "").trim()) {
            throw new Error("请先选择目标群 / 频道");
          }
          state.settingsNotice = "正在读取该群的话题...";
          await loadTelegramTopics(targetChat);
          state.settingsNotice = state.telegramTopics.length
            ? `已读取 ${state.telegramTopics.length} 个话题，请从下拉框选择。`
            : "该群没有读取到话题，或不是话题群。";
        }
        const latest = await loadSettings();
        renderSettings(latest);
      } catch (error) {
        state.settingsNotice = error.message;
        const latest = state.settings || settings;
        renderSettings(latest);
      }
    });
  });

  detailPanel.querySelectorAll("[data-login-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const form = document.querySelector("#settingsForm");
      try {
        if (button.dataset.loginAction === "start") {
          await saveCurrentSettingsFromForm(form);
          const result = await postJson("/api/login/start", {});
          if (!result.ok) {
            throw new Error(result.error || "发送验证码失败");
          }
        } else if (button.dataset.loginAction === "verify") {
          const result = await postJson("/api/login/verify", {
            code: new FormData(form).get("login_code"),
            password: new FormData(form).get("login_password"),
          });
          if (!result.ok && result.status !== "need_2fa") {
            throw new Error(result.error || "登录验证失败");
          }
        } else if (button.dataset.loginAction === "cancel") {
          const result = await postJson("/api/login/cancel", {});
          if (!result.ok) {
            throw new Error(result.error || "取消失败");
          }
        }
        const latest = await loadSettings();
        renderSettings(latest);
      } catch (error) {
        showError(error);
      }
    });
  });

  bindAccountControls();
}

function renderAccountList() {
  if (!state.accounts.length) {
    return `<p class="empty inline">还没有 Telegram 账号。点右上角「+ 登录账号」把账号挂上来,把消息搬进消息箱。</p>`;
  }
  const running = state.listenerSummary?.running || {};
  const collector = state.listenerSummary?.collector || "";
  return state.accounts
    .map((account) => {
      const listener = running[account.local_id] || {};
      const listenerStatus = listener.status || account.listener_status || "stopped";
      const isCollecting = collector === account.local_id || listenerStatus === "running" || listenerStatus === "starting" || listenerStatus === "reconnecting";
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

function renderIdentityList() {
  if (!state.identities.length) {
    return `<p class="empty inline">尚未保存游戏身份。登录某个 Telegram 账号后会自动建一条 self-identity（identity_id == account_id）;以频道身份发请手动建一条 identity_id 为 -100… 的 channel-identity。</p>`;
  }
  return state.identities
    .map((identity) => {
      const accountLabel = identity.account?.label || identity.account_local_id || "未绑定账号";
      const name = identity.label || identity.username || identity.send_as_id;
      const kind = identityKindLabel(identity.kind);
      return `
        <article class="identity-item" data-identity-id="${escapeAttr(identity.send_as_id)}">
          <div>
            <strong>${escapeHtml(name)}</strong>
            <small><span class="identity-kind ${escapeAttr(identity.kind || "unknown")}">${escapeHtml(kind)}</span>｜send_as ${escapeHtml(identity.send_as_id)}${identity.username ? `｜@${escapeHtml(identity.username)}` : ""}｜账号 ${escapeHtml(accountLabel)}</small>
            <small>${identity.enabled ? "已启用" : "已停用"}${identity.note ? `｜${escapeHtml(identity.note)}` : ""}</small>
          </div>
          <div class="account-actions">
            <button type="button" data-identity-action="fill" data-identity-id="${escapeAttr(identity.send_as_id)}">编辑</button>
            <button type="button" data-identity-action="delete" data-identity-id="${escapeAttr(identity.send_as_id)}">删除</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function identityKindLabel(kind) {
  if (kind === "self") {
    return "自己 (self)";
  }
  if (kind === "channel") {
    return "频道 (channel)";
  }
  if (kind === "self_unbound") {
    return "未关联账号";
  }
  return "未识别";
}

function renderSidebarIdentityList() {
  if (!sidebarIdentityList) return;
  if (!state.identities.length) {
    sidebarIdentityList.innerHTML = '<p class="empty">还没有身份。登录账号后会自动建好。</p>';
    return;
  }
  sidebarIdentityList.innerHTML = state.identities.map((identity) => {
    const account = state.accounts.find((a) => a.local_id === identity.account_local_id);
    const status = identityRowStatusText(identity, account);
    const offline = identityRowIsOffline(identity, account);
    const active = identity.send_as_id === state.activeIdentityId;
    const klass = ["identity-row", offline ? "offline" : "", active ? "active" : ""].filter(Boolean).join(" ");
    const name = identity.label || identity.username || identity.send_as_id;
    const modulesLine = renderIdentityModulesLine(identity.send_as_id);
    return `
      <button type="button" class="${klass}" data-identity-row="${escapeAttr(String(identity.send_as_id))}">
        <strong>${escapeHtml(String(name))}</strong>
        <span class="identity-row-status">${escapeHtml(status)}</span>
        ${modulesLine}
      </button>
    `;
  }).join("");
  sidebarIdentityList.querySelectorAll("[data-identity-row]").forEach((row) => {
    row.addEventListener("click", () => {
      const id = Number(row.dataset.identityRow);
      state.activeIdentityId = state.activeIdentityId === id ? null : id;
      renderSidebarIdentityList();
    });
  });
}

const MODULE_ICONS = { deep_retreat: "📿", pet_touch: "🖐️", pet_warm: "🔥", pet_trial: "⚔️" };

function moduleStartTs(state) {
  if (!state) return 0;
  return Number(state.entered_at || state.last_touched_at || state.last_warmed_at || 0) || 0;
}

function fmtCountdown(secondsLeft) {
  const s = Math.max(0, Math.floor(secondsLeft));
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h}h ${String(m).padStart(2, "0")}m`;
  }
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function renderIdentityModulesLine(sendAsId) {
  const items = state.identityModuleStates.get(Number(sendAsId)) || [];
  if (!items.length) return "";
  const nowSec = Date.now() / 1000;
  const parts = items.map((item) => {
    const icon = MODULE_ICONS[item.module_key] || "•";
    const summary = item.summary || {};
    const st = item.state || {};
    const nextAt = Number(summary.next_at || st.cooldown_until || 0) || 0;
    const startTs = moduleStartTs(st);
    const label = escapeHtml(item.label || item.module_key);
    const liveReady = summary.ready === true || (nextAt > 0 && nextAt <= nowSec) || nextAt === 0;
    if (liveReady) {
      return `<span class="module-chip module-ready">${icon} ${label} 已就绪</span>`;
    }
    const remaining = nextAt - nowSec;
    const total = Math.max(1, nextAt - startTs);
    const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
    const text = remaining > 0 ? `剩 ${fmtCountdown(remaining)}` : "已就绪";
    return `
      <span class="module-chip module-waiting" data-module-chip="1"
            data-next-at="${nextAt}" data-start-at="${startTs}" data-icon="${icon}" data-label="${label}">
        <span class="module-chip-text">${icon} ${label} <span class="module-chip-time">${escapeHtml(text)}</span></span>
        <span class="module-chip-bar"><span class="module-chip-bar-fill" style="width:${pct.toFixed(1)}%"></span></span>
      </span>
    `;
  });
  return `<span class="identity-row-modules">${parts.join("")}</span>`;
}

function tickIdentityModuleChips() {
  if (!sidebarIdentityList) return;
  const chips = sidebarIdentityList.querySelectorAll('[data-module-chip="1"]');
  if (!chips.length) return;
  const nowSec = Date.now() / 1000;
  chips.forEach((chip) => {
    const nextAt = Number(chip.dataset.nextAt || 0);
    const startTs = Number(chip.dataset.startAt || 0);
    const icon = chip.dataset.icon || "";
    const label = chip.dataset.label || "";
    const remaining = nextAt - nowSec;
    if (remaining <= 0) {
      chip.classList.remove("module-waiting");
      chip.classList.add("module-ready");
      chip.removeAttribute("data-module-chip");
      chip.innerHTML = `${icon} ${label} 已就绪`;
      return;
    }
    const total = Math.max(1, nextAt - startTs);
    const pct = Math.min(100, Math.max(0, ((total - remaining) / total) * 100));
    const timeEl = chip.querySelector(".module-chip-time");
    const fillEl = chip.querySelector(".module-chip-bar-fill");
    if (timeEl) timeEl.textContent = `剩 ${fmtCountdown(remaining)}`;
    if (fillEl) fillEl.style.width = `${pct.toFixed(1)}%`;
  });
}

function identityRowStatusText(identity, account) {
  if (!identity.enabled) return "已停用";
  if (!account) return "未绑定账号";
  const loginStatus = account.login_status || "idle";
  if (loginStatus === "done") {
    if (identity.kind === "self") return "已登录｜以自己身份";
    if (identity.kind === "channel") return "已登录｜以频道身份";
    return "已登录";
  }
  if (loginStatus === "waiting_code") return "等验证码";
  if (loginStatus === "need_2fa") return "需要 2FA";
  if (loginStatus === "error") return "账号离线｜登录出错";
  return "账号未登录";
}

function identityRowIsOffline(identity, account) {
  if (!account) return true;
  const status = account.login_status || "idle";
  return status === "error" || status === "idle";
}

function updateCurrentAccountLine() {
  if (!currentAccountLine) return;
  const loggedIn = state.accounts.filter((a) => (a.login_status || "") === "done");
  if (loggedIn.length === 0) {
    currentAccountLine.textContent = "当前账号: 未登录";
    return;
  }
  if (loggedIn.length === 1) {
    const a = loggedIn[0];
    const id = a.account_id ? ` (${a.account_id})` : "";
    currentAccountLine.textContent = `当前账号: ${a.label || a.local_id}${id}`;
    return;
  }
  currentAccountLine.textContent = `已登录 ${loggedIn.length} 个账号`;
}

function updateAccountActionGuards() {
  const loggedInCount = state.accounts.filter((a) => (a.login_status || "") === "done").length;
  const anyCount = state.accounts.length;
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

function openAddIdentityModal() {
  const accountOptions = state.accounts
    .map((account) => {
      const label = `${account.label || account.local_id}｜${account.local_id}`;
      const status = account.login_status === "done" ? " ✓" : " (未登录)";
      return `<option value="${escapeAttr(account.local_id)}">${escapeHtml(label)}${status}</option>`;
    })
    .join("");
  const accountPickerOptions = `<option value="">选择账号</option>${accountOptions}`;
  const dialog = openModal({
    title: "新增身份",
    body: `
      <section class="modal-section">
        <h4>1. 选账号 + 拉可用身份</h4>
        <div class="form-grid">
          <label>
            <span>账号</span>
            <select data-send-as-field="account">${accountPickerOptions}</select>
          </label>
          <label>
            <span>目标群(可选)</span>
            <input data-send-as-field="target_chat" placeholder="留空走该账号的 target_chat" />
          </label>
        </div>
        <div class="form-actions">
          <button type="button" class="primary" data-send-as-action="load">获取可用身份</button>
          <button type="button" data-send-as-action="open-logout" hidden>退出此账号</button>
        </div>
        <p class="modal-status-line info" data-send-as-status>选账号后点「获取可用身份」,会拉出该账号在目标群里所有 send_as peer。</p>
      </section>

      <section class="modal-section">
        <h4>2. 勾选要添加的身份</h4>
        <div class="send-as-bulk-bar" hidden>
          <span data-send-as-summary></span>
          <div class="send-as-bulk-actions">
            <button type="button" data-send-as-action="select-all">全选</button>
            <button type="button" data-send-as-action="select-none">全不选</button>
            <button type="button" class="primary" data-send-as-action="batch-save">保存选中</button>
          </div>
        </div>
        <div data-send-as-list class="send-as-list"></div>
        <div data-send-as-result class="send-as-result" hidden></div>
      </section>

      <details class="modal-section">
        <summary>手动添加单条(GetSendAs 没列出来时用)</summary>
        <div>
          <div class="form-grid">
            <label>
              <span>身份 ID</span>
              <input id="manualSendAsId" placeholder="正数=TG 用户;负数=-100…频道 ID" />
            </label>
            <label>
              <span>显示名(可选)</span>
              <input id="manualLabel" placeholder="留空会用 Telegram 解析的名字" />
            </label>
          </div>
          <div class="form-actions">
            <button type="button" id="manualAddIdentityBtn">添加这一条</button>
          </div>
          <p class="modal-status-line info" id="manualAddStatus" hidden></p>
        </div>
      </details>
    `,
    footer: `<button type="button" data-modal-close>关闭</button>`,
  });
  if (!dialog) return;
  bindAddIdentityModal(dialog);
}

function bindAddIdentityModal(dialog) {
  const accountSelect = dialog.querySelector('[data-send-as-field="account"]');
  const logoutBtn = dialog.querySelector('[data-send-as-action="open-logout"]');
  if (accountSelect && logoutBtn) {
    const update = () => {
      const localId = accountSelect.value;
      const account = state.accounts.find((a) => a.local_id === localId);
      logoutBtn.hidden = !account || account.login_status !== "done";
    };
    accountSelect.addEventListener("change", update);
    update();
  }

  dialog.querySelectorAll("[data-send-as-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.sendAsAction;
      if (action === "load") {
        await loadSendAsListIntoForm(dialog, button);
        return;
      }
      if (action === "select-all") {
        selectAllSendAs(dialog, "all");
        return;
      }
      if (action === "select-none") {
        selectAllSendAs(dialog, "none");
        return;
      }
      if (action === "batch-save") {
        await batchSaveSelectedSendAs(dialog, button);
        return;
      }
      if (action === "open-logout") {
        const localId = accountSelect?.value || "";
        closeModal();
        openLogoutAccountModal(localId);
        return;
      }
    });
  });

  const manualBtn = dialog.querySelector("#manualAddIdentityBtn");
  if (manualBtn) {
    manualBtn.addEventListener("click", async () => {
      const idInput = dialog.querySelector("#manualSendAsId");
      const labelInput = dialog.querySelector("#manualLabel");
      const status = dialog.querySelector("#manualAddStatus");
      const localId = accountSelect?.value || "";
      const sendAsId = (idInput?.value || "").trim();
      if (!localId) {
        status.hidden = false;
        status.className = "modal-status-line warn";
        status.textContent = "请先选账号";
        return;
      }
      if (!sendAsId) {
        status.hidden = false;
        status.className = "modal-status-line warn";
        status.textContent = "请填 send_as_id";
        return;
      }
      manualBtn.disabled = true;
      status.hidden = false;
      status.className = "modal-status-line info";
      status.textContent = "正在解析并保存…";
      try {
        let label = (labelInput?.value || "").trim();
        let username = "";
        if (!label) {
          const resolved = await postJson("/api/accounts/resolve-entity", {
            local_id: localId,
            send_as_id: Number(sendAsId),
          }).catch(() => ({ ok: false }));
          if (resolved.ok) {
            label = resolved.label || "";
            username = resolved.username || "";
          }
        }
        const result = await postJson("/api/identities", {
          send_as_id: sendAsId,
          account_local_id: localId,
          label,
          username,
          enabled: true,
        });
        if (!result.ok) throw new Error(result.error || "保存失败");
        status.className = "modal-status-line ok";
        status.textContent = `已添加 ${result.identity?.label || result.identity?.send_as_id}`;
        idInput.value = "";
        labelInput.value = "";
        await loadIdentities();
      } catch (error) {
        status.className = "modal-status-line error";
        status.textContent = error.message || "添加失败";
      } finally {
        manualBtn.disabled = false;
      }
    });
  }
}

// ---------- 官方定时 ----------

async function openScheduleModal() {
  const [presetsPayload, batchesPayload] = await Promise.all([
    fetchJson("/api/schedule/presets"),
    fetchJson("/api/schedule"),
  ]);
  const presets = presetsPayload.presets || [];
  const batches = batchesPayload.batches || [];
  const identityOptions = state.identities
    .map((id) => {
      const label = `${id.label || id.username || id.send_as_id}｜send_as ${id.send_as_id}`;
      return `<option value="${escapeAttr(String(id.send_as_id))}">${escapeHtml(label)}</option>`;
    })
    .join("");
  const presetOptions = presets
    .map((p) => `<option value="${escapeAttr(p.key)}">${escapeHtml(p.label)} — ${escapeHtml(p.description)}</option>`)
    .join("");
  const dialog = openModal({
    title: "官方定时排班",
    body: `
      <section class="modal-section">
        <h4>新建排班</h4>
        <p class="muted">预设排「深度闭关 / 抚摸法宝 / 温养器灵 / 器灵试炼」常用 CD;自定义可填任意命令 + 间隔。所有定时走 Telegram 官方 scheduled message,**不**会自动补发。多选身份会一次为每个身份各起一批,按「错峰偏移 + 阶梯」自动错开。</p>
        <form id="scheduleForm" class="settings-form">
          <div class="form-grid">
            <label class="span-2">
              <span>身份(支持多选,Ctrl/⌘ 点击选多个)</span>
              <select name="send_as_ids" multiple size="6" id="scheduleSendAsSelect">${identityOptions || '<option value="">没有可用身份</option>'}</select>
              <small class="muted">已选 <span id="scheduleSendAsCount">0</span> 个</small>
            </label>
            <label>
              <span>预设</span>
              <select name="preset_key">${presetOptions}</select>
            </label>
            <label>
              <span>批量阶梯(每个身份递增分钟)</span>
              <input name="offset_step_minutes" inputmode="numeric" value="5" placeholder="批量时每个身份 offset 递增,1 个就不生效" />
            </label>
            <label data-show-when="pet_name">
              <span>法宝名</span>
              <input name="pet_name" placeholder="留空表示不带名字" />
            </label>
            <label data-show-when="trigger_command">
              <span>触发词(可选)</span>
              <input name="trigger_command" placeholder="深闭默认「查看闭关」,留空走默认;其他 preset 留空 = 不发触发" />
            </label>
            <label data-show-when="horizon_days">
              <span>排几天(1-21)</span>
              <input name="horizon_days" inputmode="numeric" min="1" max="21" value="3" />
            </label>
            <label data-show-when="command">
              <span>自定义命令</span>
              <input name="command" placeholder="例如 .签到" />
            </label>
            <label data-show-when="interval_sec">
              <span>间隔(秒)</span>
              <input name="interval_sec" inputmode="numeric" value="3600" />
            </label>
            <label data-show-when="count">
              <span>次数</span>
              <input name="count" inputmode="numeric" value="3" />
            </label>
            <label>
              <span>错峰偏移(分钟)</span>
              <input name="offset_minutes" inputmode="numeric" value="0" placeholder="0 = 不偏" title="多账号同时建议各错开 3-15 分钟,避免天尊同一刻被多账号挤" />
            </label>
            <label class="span-2">
              <span>锚点时间(留空 = 现在)</span>
              <input name="anchor_at_text" type="datetime-local" />
            </label>
          </div>
          <label class="toggle-row">
            <input type="checkbox" name="auto_anchor" />
            <span>自动锚点(按状态机算下一次可用,覆盖上面手填的锚点)</span>
          </label>
          <label class="toggle-row">
            <input type="checkbox" name="dry_run" checked />
            <span>仅预演(只在本地记录,不真正排到 Telegram)— 没登录或想试就开着</span>
          </label>
          <div class="form-actions">
            <button type="button" data-schedule-action="preview">预览计划</button>
            <button type="button" class="primary" data-schedule-action="create">创建</button>
          </div>
        </form>
        <p class="modal-status-line info" id="scheduleStatus" hidden></p>
        <div id="schedulePreview" class="send-as-result" hidden></div>
      </section>

      <section class="modal-section">
        <h4>对账 Telegram 端</h4>
        <p class="muted">拉 TG 的 GetScheduledHistory,跟本地批次对账,标出「TG 有 mini-web 没记录」(orphans) 和「本地标了已排但 TG 没找到」(lost) 的项。</p>
        <div class="form-grid">
          <label class="span-2">
            <span>对账身份</span>
            <select id="scheduleSyncSelect">${identityOptions || '<option value="">没有可用身份</option>'}</select>
          </label>
        </div>
        <div class="form-actions">
          <button type="button" id="scheduleSyncButton">拉 TG 状态对账</button>
        </div>
        <p class="modal-status-line info" id="scheduleSyncStatus" hidden></p>
        <div id="scheduleSyncResult" class="send-as-result" hidden></div>
      </section>

      <section class="modal-section">
        <h4>本地排班记录</h4>
        <p class="muted">这些是 mini-web 自己存的批次。dry_run=False 那次会同时排到 Telegram;有 scheduled_msg_id 的就是真排上的。</p>
        <div id="scheduleBatchList">${renderScheduleBatches(batches)}</div>
      </section>
    `,
    footer: `<button type="button" data-modal-close>关闭</button>`,
  });
  if (!dialog) return;
  bindScheduleModal(dialog, presets, batches);
}

function renderScheduleBatches(batches) {
  if (!batches.length) {
    return '<p class="empty inline">还没有任何官方定时批次。上面新建一个。</p>';
  }
  return batches
    .map((b) => {
      const items = (b.items || [])
        .map((m) => {
          const stat = m.status === "scheduled"
            ? `<span class="status-pill ok">已排</span>`
            : m.status === "failed"
              ? `<span class="status-pill risk">失败</span>`
              : `<span class="status-pill">planned</span>`;
          return `
            <li>
              <code>${escapeHtml(m.command)}</code>
              <small>${escapeHtml(m.schedule_text || "")}</small>
              ${stat}
              ${m.scheduled_msg_id ? `<small>TG #${m.scheduled_msg_id}</small>` : ""}
              ${m.last_error ? `<small class="error">${escapeHtml(m.last_error)}</small>` : ""}
            </li>
          `;
        })
        .join("");
      const counts = b.counts || {};
      const total = (counts.planned || 0) + (counts.scheduled || 0) + (counts.failed || 0);
      const done = (counts.scheduled || 0) + (counts.failed || 0);
      const pct = total ? Math.round((done / total) * 100) : 0;
      const statusKey = b.status || "active";
      const statusText = scheduleStatusText(statusKey, counts);
      const statusPill = scheduleStatusPill(statusKey);
      const showProgress = statusKey === "sending" || (counts.planned > 0 && counts.scheduled > 0);
      const cancelBtn = statusKey === "sending"
        ? `<button type="button" data-schedule-action="cancel" data-batch-id="${escapeAttr(String(b.id))}">取消</button>`
        : "";
      return `
        <article class="account-row" data-schedule-batch-id="${escapeAttr(String(b.id))}">
          <span class="account-row-dot ${statusKey === "sending" ? "live" : counts.failed ? "warn" : counts.scheduled ? "live" : "idle"}" aria-hidden="true"></span>
          <div class="account-row-body">
            <div class="account-row-title">
              <strong>${escapeHtml(b.label || b.preset_key)}</strong>
              ${statusPill}
              <span class="account-row-meta">send_as ${b.send_as_id}｜${b.anchor_text || ""}｜${b.horizon_days} 天｜${escapeHtml(statusText)}</span>
            </div>
            ${showProgress ? `<div class="schedule-progress"><div class="schedule-progress-bar" style="width:${pct}%"></div></div>` : ""}
            <ul class="schedule-item-list">${items}</ul>
          </div>
          <div class="account-row-actions">
            ${cancelBtn}
            <button type="button" data-schedule-action="delete" data-batch-id="${escapeAttr(String(b.id))}">删除</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function scheduleStatusText(statusKey, counts) {
  const c = counts || {};
  const total = (c.planned || 0) + (c.scheduled || 0) + (c.failed || 0);
  const done = (c.scheduled || 0) + (c.failed || 0);
  if (statusKey === "sending") return `发送中 ${done}/${total}${c.failed ? ` (${c.failed} 失败)` : ""}`;
  if (statusKey === "completed") return `已完成 ${c.scheduled || 0}/${total}`;
  if (statusKey === "partial_failed") return `部分失败 ${c.scheduled || 0}/${total}（${c.failed || 0} 失败）`;
  if (statusKey === "failed") return `全部失败`;
  if (statusKey === "cancelled") return `已取消 (排到 ${c.scheduled || 0}/${total})`;
  return `${c.scheduled || 0}/${total} 已排`;
}

function scheduleStatusPill(statusKey) {
  if (statusKey === "sending") return `<span class="status-pill warn">拟人发送中</span>`;
  if (statusKey === "completed") return `<span class="status-pill ok">完成</span>`;
  if (statusKey === "partial_failed") return `<span class="status-pill warn">部分失败</span>`;
  if (statusKey === "failed") return `<span class="status-pill risk">失败</span>`;
  if (statusKey === "cancelled") return `<span class="status-pill">已取消</span>`;
  return "";
}

function bindScheduleModal(dialog, presets, _initialBatches) {
  const form = dialog.querySelector("#scheduleForm");
  const status = dialog.querySelector("#scheduleStatus");
  const preview = dialog.querySelector("#schedulePreview");
  const batchList = dialog.querySelector("#scheduleBatchList");
  const syncButton = dialog.querySelector("#scheduleSyncButton");
  const syncSelect = dialog.querySelector("#scheduleSyncSelect");
  const syncStatus = dialog.querySelector("#scheduleSyncStatus");
  const syncResult = dialog.querySelector("#scheduleSyncResult");
  if (!form) return;
  const presetMap = new Map(presets.map((p) => [p.key, p]));
  const setStatus = (kind, text) => {
    if (!status) return;
    status.hidden = !text;
    status.className = `modal-status-line ${kind}`;
    status.textContent = text || "";
  };
  const showPreview = (html) => {
    if (!preview) return;
    preview.hidden = !html;
    preview.innerHTML = html || "";
  };
  const updateFieldVisibility = () => {
    const key = form.querySelector('[name="preset_key"]').value;
    const required = new Set(presetMap.get(key)?.fields || []);
    form.querySelectorAll("[data-show-when]").forEach((label) => {
      const fieldName = label.dataset.showWhen;
      label.style.display = required.has(fieldName) ? "" : "none";
    });
  };
  updateFieldVisibility();
  form.querySelector('[name="preset_key"]').addEventListener("change", updateFieldVisibility);

  const collectPayload = () => {
    const data = new FormData(form);
    // 多选身份 — FormData.getAll 拿到 string 数组,转 number
    const sendAsIds = data.getAll("send_as_ids").map((v) => Number(v)).filter(Boolean);
    const payload = {
      send_as_ids: sendAsIds,
      send_as_id: sendAsIds[0] || 0,  // 兼容老 server 字段
      preset_key: data.get("preset_key"),
      pet_name: (data.get("pet_name") || "").trim(),
      horizon_days: data.get("horizon_days") || 3,
      command: (data.get("command") || "").trim(),
      interval_sec: data.get("interval_sec") || 3600,
      count: data.get("count") || 1,
      dry_run: data.get("dry_run") === "on",
      auto_anchor: data.get("auto_anchor") === "on",
      trigger_command: (data.get("trigger_command") || "").trim(),
      offset_minutes: data.get("offset_minutes") || 0,
      offset_step_minutes: data.get("offset_step_minutes") || 5,
    };
    if (payload.auto_anchor) {
      // auto_anchor 默认按 preset_key 对应的 module(deep_retreat/pet_touch/pet_warm 命名一致)
      payload.auto_anchor_module = data.get("preset_key");
    }
    const anchorText = data.get("anchor_at_text");
    if (anchorText) {
      const parsed = new Date(String(anchorText));
      if (!Number.isNaN(parsed.getTime())) {
        payload.anchor_at = Math.floor(parsed.getTime() / 1000);
      }
    }
    return payload;
  };

  // 多选 select 选中数量同步显示
  const sendAsSelect = dialog.querySelector("#scheduleSendAsSelect");
  const sendAsCount = dialog.querySelector("#scheduleSendAsCount");
  if (sendAsSelect && sendAsCount) {
    const refreshCount = () => {
      sendAsCount.textContent = String(Array.from(sendAsSelect.selectedOptions).length);
    };
    sendAsSelect.addEventListener("change", refreshCount);
    refreshCount();
  }

  dialog.querySelectorAll("[data-schedule-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const action = btn.dataset.scheduleAction;
      if (action === "preview") {
        setStatus("info", "计算预览…");
        try {
          const result = await postJson("/api/schedule/preview", collectPayload());
          if (!result.ok) throw new Error(result.error || "预览失败");
          showPreview(`
            <p>预设 <strong>${escapeHtml(result.preset_label)}</strong>｜锚点 ${escapeHtml(result.anchor_text)}${result.auto_anchor_used ? '<small class="status-pill ok" style="margin-left:6px">自动锚点</small>' : ""}｜首次发送 ${escapeHtml(result.first_due_text || result.anchor_text)}｜${result.horizon_days} 天</p>
            <ul class="send-as-result-list">
              ${(result.items || []).map((it) => `<li class="ok"><code>${escapeHtml(it.command)}</code> <small>${escapeHtml(it.schedule_text || "")}</small></li>`).join("") || "<li>(0 条)</li>"}
            </ul>
          `);
          setStatus("ok", `共 ${(result.items || []).length} 条`);
        } catch (error) {
          setStatus("error", error.message);
        }
        return;
      }
      if (action === "create") {
        if (!window.confirm("确认创建?dry_run 关掉的话会按拟人节奏后台发,可能要 30+ 分钟。")) return;
        btn.disabled = true;
        setStatus("info", "创建中…");
        try {
          const result = await postJson("/api/schedule/create", collectPayload());
          if (!result.ok && !result.batch_count) throw new Error(result.error || "创建失败");
          let stats;
          if (result.batch_count) {
            // 批量模式 — N 个身份各起一个 batch
            const okN = result.succeeded || 0;
            const failN = result.failed || 0;
            const totalMin = Math.round((result.total_estimate_seconds || 0) / 60);
            stats = `批量创建 ${result.batch_count} 个身份｜成功 ${okN}${failN ? `｜失败 ${failN}` : ""}｜阶梯 ${result.offset_step_minutes}min｜总预估 ${totalMin}min`;
            // 启动每个 sending batch 的进度轮询
            for (const r of (result.results || [])) {
              if (r.ok && r.status === "sending" && r.batch_id) {
                scheduleProgressPolling(dialog, r.batch_id);
              }
            }
          } else {
            // 单个模式 — 老的展示
            stats = `批次 #${result.batch_id}｜planned ${result.planned_count}`;
            if (result.dry_run) {
              stats += "｜dry_run";
            } else if (result.status === "sending") {
              const mins = Math.round((result.estimate_seconds || 0) / 60);
              stats += `｜后台拟人发送中,预估 ${mins} 分钟｜可在下方批次列表里取消`;
              scheduleProgressPolling(dialog, result.batch_id);
            } else {
              stats += `｜TG 排上 ${result.created_official}`;
            }
          }
          setStatus(result.errors?.length || result.failed ? "warn" : "ok", stats);
          // 刷新批次列表
          const refreshed = await fetchJson("/api/schedule");
          if (batchList) batchList.innerHTML = renderScheduleBatches(refreshed.batches || []);
          bindScheduleBatchActions(dialog);
        } catch (error) {
          setStatus("error", error.message);
        } finally {
          btn.disabled = false;
        }
        return;
      }
      if (action === "cancel") {
        const batchId = btn.dataset.batchId;
        if (!batchId) return;
        if (!window.confirm(`取消批次 #${batchId}?已经排到 TG 的会保留(可再点删除一并清掉)。`)) return;
        btn.disabled = true;
        try {
          const result = await postJson("/api/schedule/cancel", { batch_id: Number(batchId) });
          if (!result.ok) throw new Error(result.error || "取消失败");
          setStatus("ok", `批次 #${batchId} 已取消(后台 loop 在下条时退出)`);
          const refreshed = await fetchJson("/api/schedule");
          if (batchList) batchList.innerHTML = renderScheduleBatches(refreshed.batches || []);
          bindScheduleBatchActions(dialog);
        } catch (error) {
          setStatus("error", error.message);
        } finally {
          btn.disabled = false;
        }
        return;
      }
      if (action === "delete") {
        const batchId = btn.dataset.batchId;
        if (!batchId) return;
        if (!window.confirm(`删除批次 #${batchId}?如果是真排过 TG,也会一起从 TG 取消。`)) return;
        btn.disabled = true;
        setStatus("info", "删除中…");
        try {
          const result = await postJson("/api/schedule/delete", { batch_id: Number(batchId) });
          if (!result.ok) throw new Error(result.error || "删除失败");
          setStatus("ok", `已删除批次 #${batchId}｜本地 ${result.local?.messages || 0} 条｜TG 取消 ${result.tg_deleted || 0} 条${result.tg_error ? `｜TG 错误:${result.tg_error}` : ""}`);
          const refreshed = await fetchJson("/api/schedule");
          if (batchList) batchList.innerHTML = renderScheduleBatches(refreshed.batches || []);
          bindScheduleBatchActions(dialog);
        } catch (error) {
          setStatus("error", error.message);
        } finally {
          btn.disabled = false;
        }
        return;
      }
    });
  });
  bindScheduleBatchActions(dialog);

  if (syncButton && syncSelect) {
    const setSyncStatus = (kind, text) => {
      syncStatus.hidden = !text;
      syncStatus.className = `modal-status-line ${kind}`;
      syncStatus.textContent = text || "";
    };
    syncButton.addEventListener("click", async () => {
      const sendAs = syncSelect.value;
      if (!sendAs) {
        setSyncStatus("warn", "请选身份");
        return;
      }
      syncButton.disabled = true;
      setSyncStatus("info", "正在调 GetScheduledHistory 对账…");
      try {
        const result = await fetchJson(`/api/schedule/sync?send_as_id=${encodeURIComponent(sendAs)}`);
        if (!result.ok) throw new Error(result.error || "对账失败");
        const tg = result.tg_messages || [];
        const matched = result.matched || [];
        const orphans = result.orphans || [];
        const lost = result.lost || [];
        setSyncStatus(orphans.length || lost.length ? "warn" : "ok", `TG ${tg.length} 条｜对得上 ${matched.length}｜TG 有本地没的 ${orphans.length}｜本地标排 TG 没找到 ${lost.length}`);
        syncResult.hidden = false;
        syncResult.innerHTML = `
          <p><strong>Telegram 端当前 ${tg.length} 条 scheduled message</strong></p>
          <ul class="send-as-result-list">
            ${tg.map((m) => `<li class="ok"><code>${escapeHtml(m.message.slice(0, 40))}</code> <small>${escapeHtml(m.schedule_text || "")}｜TG #${m.scheduled_msg_id}</small></li>`).join("") || "<li>(空)</li>"}
          </ul>
          ${orphans.length ? `<p><strong>⚠ TG 有但 mini-web 没记录的 ${orphans.length} 条</strong>(可能是从其它工具或手机端排的):</p><ul class="send-as-result-list">${orphans.map((m) => `<li class="warn"><code>${escapeHtml(m.message.slice(0, 40))}</code> <small>TG #${m.scheduled_msg_id}｜${escapeHtml(m.schedule_text || "")}</small></li>`).join("")}</ul>` : ""}
          ${lost.length ? `<p><strong>⚠ 本地标已排但 TG 找不到的 ${lost.length} 条</strong>(可能被 TG 端取消了):</p><ul class="send-as-result-list">${lost.map((m) => `<li class="warn"><code>${escapeHtml(m.command)}</code> <small>本地 #${m.id}｜TG 期望 #${m.scheduled_msg_id}</small></li>`).join("")}</ul>` : ""}
        `;
      } catch (error) {
        setSyncStatus("error", error.message);
      } finally {
        syncButton.disabled = false;
      }
    });
  }
}

function bindScheduleBatchActions(dialog) {
  // 删除按钮重新挂(重渲后 listener 失效)
  dialog.querySelectorAll('[data-schedule-action="delete"]').forEach((btn) => {
    if (btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", async () => {
      const batchId = btn.dataset.batchId;
      if (!batchId) return;
      if (!window.confirm(`删除批次 #${batchId}?`)) return;
      try {
        const result = await postJson("/api/schedule/delete", { batch_id: Number(batchId) });
        if (!result.ok) throw new Error(result.error || "删除失败");
        const refreshed = await fetchJson("/api/schedule");
        const batchList = dialog.querySelector("#scheduleBatchList");
        if (batchList) batchList.innerHTML = renderScheduleBatches(refreshed.batches || []);
        bindScheduleBatchActions(dialog);
      } catch (error) {
        window.alert(error.message || "删除失败");
      }
    });
  });
  // 取消按钮(只在 status=sending 时有)
  dialog.querySelectorAll('[data-schedule-action="cancel"]').forEach((btn) => {
    if (btn.dataset.bound === "1") return;
    btn.dataset.bound = "1";
    btn.addEventListener("click", async () => {
      const batchId = btn.dataset.batchId;
      if (!batchId) return;
      if (!window.confirm(`取消批次 #${batchId}?已经排到 TG 的会保留(可点删除一并清掉)。`)) return;
      try {
        const result = await postJson("/api/schedule/cancel", { batch_id: Number(batchId) });
        if (!result.ok) throw new Error(result.error || "取消失败");
        const refreshed = await fetchJson("/api/schedule");
        const batchList = dialog.querySelector("#scheduleBatchList");
        if (batchList) batchList.innerHTML = renderScheduleBatches(refreshed.batches || []);
        bindScheduleBatchActions(dialog);
      } catch (error) {
        window.alert(error.message || "取消失败");
      }
    });
  });
}

// dialog 上挂个 ~8s 轮询,直到目标 batch 离开 sending 状态(或 1 小时硬上限)。
// 当 dialog 被关闭(.modal-backdrop 不在 DOM 里),自动停。
function scheduleProgressPolling(dialog, batchId) {
  if (!dialog || !batchId) return;
  const batchList = dialog.querySelector("#scheduleBatchList");
  if (!batchList) return;
  const start = Date.now();
  const tick = async () => {
    if (!document.body.contains(dialog)) return; // dialog 关了
    if (Date.now() - start > 60 * 60 * 1000) return; // 硬上限 1h
    try {
      const refreshed = await fetchJson("/api/schedule");
      batchList.innerHTML = renderScheduleBatches(refreshed.batches || []);
      bindScheduleBatchActions(dialog);
      const target = (refreshed.batches || []).find((b) => Number(b.id) === Number(batchId));
      if (target && target.status === "sending") {
        window.setTimeout(tick, 8000);
      }
    } catch (err) {
      console.warn("[mini-web] schedule progress poll:", err);
      window.setTimeout(tick, 15000);
    }
  };
  window.setTimeout(tick, 4000);
}

function openLogoutAccountModal(presetLocalId = "") {
  const loggedIn = state.accounts.filter((a) => (a.login_status || "") === "done");
  if (loggedIn.length === 0) {
    openModal({
      title: "登出账户",
      body: `<section class="modal-section"><p class="modal-status-line info">当前没有已登录的账号,无需登出。</p></section>`,
      footer: `<button type="button" data-modal-close>知道了</button>`,
    });
    return;
  }
  const options = loggedIn
    .map((a) => `<option value="${escapeAttr(a.local_id)}" ${a.local_id === presetLocalId ? "selected" : ""}>${escapeHtml(`${a.label || a.local_id}｜${a.account_id || a.local_id}`)}</option>`)
    .join("");
  const dialog = openModal({
    title: "登出 Telegram 账号",
    body: `
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
    `,
    footer: `
      <button type="button" data-modal-close>取消</button>
      <button type="button" class="primary" id="logoutConfirmBtn">确认登出</button>
    `,
  });
  if (!dialog) return;

  const select = dialog.querySelector("#logoutAccountSelect");
  const boundLine = dialog.querySelector("#logoutBoundIdentities");
  const updateBound = () => {
    const localId = select.value;
    const count = state.identities.filter((id) => id.account_local_id === localId).length;
    boundLine.textContent = count
      ? `该账号当前绑定 ${count} 条身份(不会被删除,但会暂停)。`
      : "该账号当前没有绑定身份。";
  };
  select.addEventListener("change", updateBound);
  updateBound();

  const confirmBtn = dialog.querySelector("#logoutConfirmBtn");
  const resultLine = dialog.querySelector("#logoutResult");
  confirmBtn.addEventListener("click", async () => {
    const localId = select.value;
    if (!localId) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = "退出中…";
    resultLine.hidden = false;
    resultLine.className = "modal-status-line info";
    resultLine.textContent = "正在停 listener、清 session 文件…";
    try {
      const result = await postJson("/api/accounts/logout", { local_id: localId });
      if (!result.ok) throw new Error(result.error || "登出失败");
      resultLine.className = "modal-status-line ok";
      resultLine.textContent = `已登出。如有 ${result.bound_identities || 0} 条绑定身份,已暂停。`;
      await Promise.all([loadAccounts(), loadIdentities()]);
      setTimeout(() => closeModal(), 800);
    } catch (error) {
      resultLine.className = "modal-status-line error";
      resultLine.textContent = error.message;
      confirmBtn.disabled = false;
      confirmBtn.textContent = "确认登出";
    }
  });
}

function renderIdentityForm() {
  const accountOptions = state.accounts
    .map((account) => {
      const label = `${account.label || account.local_id}｜${account.local_id}`;
      return `<option value="${escapeAttr(account.local_id)}">${escapeHtml(label)}</option>`;
    })
    .join("");
  const accountPickerOptions = `<option value="">选择账号</option>${accountOptions}`;
  return `
    <div class="send-as-section">
      <fieldset class="send-as-picker">
        <legend>从 Telegram 拉取并批量添加身份(channels.GetSendAs)</legend>
        <div class="send-as-controls">
          <label class="send-as-control">
            <span>账号</span>
            <select data-send-as-field="account">
              ${accountPickerOptions}
            </select>
          </label>
          <label class="send-as-control">
            <span>目标群(可选)</span>
            <input data-send-as-field="target_chat" placeholder="留空走该账号配置的 target_chat" />
          </label>
          <button type="button" class="primary" data-send-as-action="load">获取可用身份</button>
        </div>
        <div class="send-as-status-bar">
          <small data-send-as-status>选账号后点「获取可用身份」,会拉出该账号在目标群里所有可用 send_as peer。</small>
        </div>
        <div class="send-as-bulk-bar" hidden>
          <span data-send-as-summary></span>
          <div class="send-as-bulk-actions">
            <button type="button" data-send-as-action="select-all">全选</button>
            <button type="button" data-send-as-action="select-none">全不选</button>
            <button type="button" class="primary" data-send-as-action="batch-save">保存选中</button>
          </div>
        </div>
        <div data-send-as-list class="send-as-list"></div>
        <div data-send-as-result class="send-as-result" hidden></div>
      </fieldset>
    </div>

    <form id="identityForm" class="settings-form account-form">
      <p class="identity-hint">下方表单适合「编辑现有身份」或「手填一条 GetSendAs 没列出的 send_as_id」。常规批量添加用上面的勾选 + 保存选中。</p>
      <div class="form-grid">
        <label>
          <span>身份 ID（send_as_id）</span>
          <input name="send_as_id" inputmode="numeric" placeholder="正数=TG 用户;负数=-100…频道 ID" />
        </label>
        <label>
          <span>绑定 Telegram 账号</span>
          <select name="account_local_id">
            <option value="">暂不绑定</option>
            ${accountOptions}
          </select>
        </label>
        <label>
          <span>显示名称</span>
          <input name="label" placeholder="例如 WA2000 / 凌霄宫公告" />
        </label>
        <label>
          <span>用户名</span>
          <input name="username" placeholder="不带 @ 也可以" />
        </label>
        <label class="span-2">
          <span>备注</span>
          <input name="note" placeholder="可选" />
        </label>
      </div>
      <label class="toggle-row">
        <input name="enabled" type="checkbox" checked />
        <span>启用身份</span>
      </label>
      <div class="form-actions">
        <button type="button" data-identity-form-action="hydrate">用 Telegram 解析此 ID</button>
        <button type="button" data-identity-form-action="clear">清空</button>
        <button type="submit">保存身份</button>
      </div>
    </form>
  `;
}

function bindAccountControls() {
  detailPanel.querySelectorAll("[data-account-action]").forEach((button) => {
    const action = button.dataset.accountAction;
    if (action === "open-new") {
      button.addEventListener("click", () => openAccountModal(null));
      return;
    }
    if (action === "open-edit") {
      button.addEventListener("click", () => {
        const localId = button.dataset.accountId;
        const account = state.accounts.find((item) => item.local_id === localId);
        if (account) openAccountModal(account);
      });
      return;
    }
    if (action === "delete") {
      button.addEventListener("click", async () => {
        const localId = button.dataset.accountId;
        const account = state.accounts.find((item) => item.local_id === localId);
        if (!account) return;
        const name = account.label || account.local_id;
        if (!window.confirm(`删除账号「${name}」?这只删本地配置和 session 引用,不会注销 Telegram 端的会话。`)) {
          return;
        }
        try {
          const result = await postJson("/api/accounts/delete", { local_id: localId });
          if (!result.ok) throw new Error(result.error || "删除失败");
          state.settingsNotice = `${name} 已删除`;
          await loadAccounts();
          renderSettings(state.settings || (await loadSettings()));
        } catch (error) {
          window.alert(error.message);
        }
      });
      return;
    }
    if (action === "toggle-collect") {
      button.addEventListener("change", async () => {
        const localId = button.dataset.accountId;
        const turningOn = button.checked;
        const endpoint = turningOn
          ? "/api/accounts/listener/start"
          : "/api/accounts/listener/stop";
        try {
          const result = await postJson(endpoint, { local_id: localId });
          if (!result.ok && result.listener?.status === "error") {
            throw new Error(result.listener.message || "采集切换失败");
          }
          if (!result.ok && result.error) {
            throw new Error(result.error);
          }
          state.settingsNotice = result.listener?.message || (turningOn ? "已切换为采集账号" : "已停止采集");
          await loadAccounts();
          renderSettings(state.settings || (await loadSettings()));
        } catch (error) {
          state.settingsNotice = error.message;
          // revert UI checkbox locally before re-render
          button.checked = !turningOn;
          renderSettings(state.settings || {});
        }
      });
      return;
    }
  });
}

async function openAccountModal(account) {
  const isNew = !account;
  const settings = state.settings || (await loadSettings());
  const modalState = {
    localId: account?.local_id || "",
    accountSnapshot: account ? { ...account } : null,
    loginStep: account?.login_status === "waiting_code"
      ? "code"
      : account?.login_status === "need_2fa"
        ? "2fa"
        : "phone",
    statusKind: account?.login_status === "done" ? "ok" : account?.login_status === "error" ? "error" : "info",
    statusText: account?.login_message || (account?.login_status === "done" ? "已登录" : "填好手机号,点「发送验证码」开始登录。"),
  };

  const dialog = openModal({
    title: isNew ? "登录 Telegram 账号" : `账号 · ${account.label || account.local_id}`,
    body: renderAccountModalBody(account, settings, modalState),
    footer: `
      <button type="button" data-modal-close>关闭</button>
      <button type="button" class="primary" data-account-modal="save">保存账号</button>
    `,
  });
  if (!dialog) return;
  bindAccountModal(dialog, account, settings, modalState);
}

function renderAccountModalBody(account, settings, modalState) {
  const acc = account || {};
  const savedSecrets = acc.saved_secrets || {};
  const renderInput = (name, value, placeholder, type = "text", attrs = "") =>
    `<input name="${name}" type="${type}" value="${escapeAttr(value || "")}" placeholder="${escapeAttr(placeholder || "")}" ${attrs} />`;
  const accountSummaryLine = acc.account_id
    ? `<p class="muted">account_id ${escapeHtml(acc.account_id)}｜session ${escapeHtml(acc.session_name || acc.local_id || "未生成")}</p>`
    : "";
  const isLoggedIn = (acc.login_status || "") === "done";
  const listenerStatus = (acc.listener_status || "stopped");
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
        <p class="modal-status-line ${modalState.statusKind}" data-account-modal-status>${escapeHtml(modalState.statusText)}</p>

        <div class="login-step" data-account-modal-step="phone">
          <div class="form-actions">
            <button type="button" data-account-modal="send-code">发送验证码</button>
          </div>
        </div>

        <div class="login-step" data-account-modal-step="code" ${modalState.loginStep === "phone" ? "hidden" : ""}>
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

        <div class="login-step" data-account-modal-step="2fa" ${modalState.loginStep === "2fa" ? "" : "hidden"}>
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
            ${renderInput("target_chat", acc.target_chat || settings.target_chat || "", "也可手动填 -100... 或 @username")}
          </div>
          <div class="picker-field">
            <div class="picker-head">
              <span>话题(可选)</span>
              <button type="button" data-listen-action="load-topics">读取话题</button>
            </div>
            <select data-listen-select="target_topic_id">
              <option value="">全部话题 / 不限制</option>
            </select>
            ${renderInput("target_topic_id", acc.target_topic_id || settings.target_topic_id || "", "话题群留空 = 全部话题", "text", 'inputmode="numeric"')}
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

function bindAccountModal(dialog, account, settings, modalState) {
  const form = dialog.querySelector("#accountModalForm");
  if (!form) return;

  const setStatus = (kind, text) => {
    modalState.statusKind = kind;
    modalState.statusText = text;
    const line = dialog.querySelector("[data-account-modal-status]");
    if (line) {
      line.className = `modal-status-line ${kind}`;
      line.textContent = text;
    }
  };
  const setStep = (step) => {
    modalState.loginStep = step;
    ["phone", "code", "2fa"].forEach((name) => {
      const node = dialog.querySelector(`[data-account-modal-step="${name}"]`);
      if (!node) return;
      const shouldHide = (name === "code" && step === "phone") || (name === "2fa" && step !== "2fa");
      node.hidden = shouldHide;
    });
  };

  const collectFormPayload = () => {
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
  };

  const ensureSaved = async () => {
    try {
      const saved = await saveAccount(collectFormPayload());
      if (saved?.local_id) {
        modalState.localId = saved.local_id;
        const localIdInput = form.querySelector('[name="local_id"]');
        if (localIdInput) localIdInput.value = saved.local_id;
      }
      return saved;
    } catch (error) {
      throw error;
    }
  };

  dialog.querySelectorAll("[data-account-modal]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.accountModal;
      try {
        if (action === "save") {
          button.disabled = true;
          await ensureSaved();
          setStatus("ok", "账号已保存");
          await loadAccounts();
          await loadIdentities();
          return;
        }
        if (action === "send-code") {
          button.disabled = true;
          setStatus("info", "正在保存账号并发送验证码...");
          await ensureSaved();
          const result = await postJson("/api/accounts/login/start", { local_id: modalState.localId });
          if (!result.ok) {
            throw new Error(result.error || result.message || "发送验证码失败");
          }
          setStep("code");
          setStatus("info", result.message || "验证码已发送,请在 Telegram 客户端查收");
          dialog.querySelector('[name="login_code"]')?.focus();
          await loadAccounts();
          return;
        }
        if (action === "verify-code") {
          button.disabled = true;
          setStatus("info", "正在校验验证码...");
          const code = form.querySelector('[name="login_code"]').value.trim();
          if (!code) throw new Error("请填写验证码");
          const result = await postJson("/api/accounts/login/verify", {
            local_id: modalState.localId,
            code,
          });
          if (result.status === "need_2fa") {
            setStep("2fa");
            setStatus("warn", result.message || "需要两步验证密码");
            dialog.querySelector('[name="login_password"]')?.focus();
            await loadAccounts();
            return;
          }
          if (!result.ok) {
            throw new Error(result.error || result.message || "验证失败");
          }
          setStep("done");
          setStatus("ok", "登录成功,下面选要采集的群和话题。");
          revealListenTarget(dialog);
          await loadAccounts();
          await loadIdentities();
          return;
        }
        if (action === "verify-2fa") {
          button.disabled = true;
          setStatus("info", "正在校验两步验证密码...");
          const password = form.querySelector('[name="login_password"]').value;
          if (!password) throw new Error("请填写 2FA 密码");
          const result = await postJson("/api/accounts/login/verify", {
            local_id: modalState.localId,
            password,
          });
          if (!result.ok) {
            throw new Error(result.error || result.message || "2FA 验证失败");
          }
          setStep("done");
          setStatus("ok", "登录成功,下面选要采集的群和话题。");          revealListenTarget(dialog);
          await loadAccounts();
          await loadIdentities();
          return;
        }
      } catch (error) {
        setStatus("error", error.message || "操作失败");
      } finally {
        button.disabled = false;
      }
    });
  });

  bindListenTargetControls(dialog, modalState);
}

function revealListenTarget(dialog) {
  const section = dialog.querySelector("[data-listen-target]");
  if (section) section.hidden = false;
}

function bindListenTargetControls(dialog, modalState) {
  const setStatus = (kind, text) => {
    const line = dialog.querySelector("[data-listen-status]");
    if (!line) return;
    line.hidden = !text;
    line.className = `modal-status-line ${kind}`;
    line.textContent = text || "";
  };
  const populateSelect = (select, items, currentValue, valueKey, labelFn) => {
    if (!select) return;
    const current = String(currentValue || "");
    const knownIds = new Set(items.map((it) => String(it[valueKey])));
    const stayCurrent = current && !knownIds.has(current);
    select.innerHTML = `
      <option value="">${select.dataset.listenSelect === "target_topic_id" ? "全部话题 / 不限制" : "未选择"}</option>
      ${stayCurrent ? `<option value="${escapeAttr(current)}" selected>当前手填: ${escapeHtml(current)}</option>` : ""}
      ${items.map((it) => {
        const v = String(it[valueKey]);
        return `<option value="${escapeAttr(v)}" ${v === current ? "selected" : ""}>${escapeHtml(labelFn(it))}</option>`;
      }).join("")}
    `;
  };
  // 群下拉 change 同步到 input
  dialog.querySelectorAll("[data-listen-select]").forEach((select) => {
    select.addEventListener("change", () => {
      const target = select.dataset.listenSelect;
      const input = dialog.querySelector(`[name="${target}"]`);
      if (input) input.value = select.value;
      // 切换群时清空话题
      if (target === "target_chat") {
        const topicInput = dialog.querySelector('[name="target_topic_id"]');
        const topicSelect = dialog.querySelector('[data-listen-select="target_topic_id"]');
        if (topicInput) topicInput.value = "";
        if (topicSelect) topicSelect.value = "";
      }
    });
  });
  dialog.querySelectorAll("[data-listen-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.listenAction;
      const localId = modalState.localId;
      if (!localId) {
        setStatus("warn", "先完成登录,系统才能用这个账号去 Telegram 拉数据");
        return;
      }
      button.disabled = true;
      try {
        if (action === "load-dialogs") {
          setStatus("info", "正在拉取该账号可见的群 / 频道…");
          const result = await fetchJson(`/api/accounts/dialogs?local_id=${encodeURIComponent(localId)}`);
          if (!result.ok) throw new Error(result.error || "拉取失败");
          const dialogsList = result.dialogs || [];
          const select = dialog.querySelector('[data-listen-select="target_chat"]');
          const currentVal = dialog.querySelector('[name="target_chat"]')?.value || "";
          populateSelect(select, dialogsList, currentVal, "id",
            (d) => `${d.title || d.id}｜${dialogKindLabel(d.kind)}｜${d.id}${d.username ? ` @${d.username}` : ""}`);
          setStatus("ok", `共 ${dialogsList.length} 个群 / 频道,从下拉里选`);
          return;
        }
        if (action === "load-topics") {
          const chat = (dialog.querySelector('[name="target_chat"]')?.value || "").trim();
          if (!chat) {
            setStatus("warn", "先选群,才能读这个群的话题");
            return;
          }
          setStatus("info", "正在拉取该群的话题…");
          const result = await fetchJson(`/api/accounts/topics?local_id=${encodeURIComponent(localId)}&chat=${encodeURIComponent(chat)}`);
          if (!result.ok) throw new Error(result.error || "拉取失败");
          const topics = result.topics || [];
          const select = dialog.querySelector('[data-listen-select="target_topic_id"]');
          const currentVal = dialog.querySelector('[name="target_topic_id"]')?.value || "";
          populateSelect(select, topics, currentVal, "id",
            (t) => `${t.title || t.id}｜${t.id}`);
          setStatus("ok", topics.length ? `共 ${topics.length} 个话题` : "该群没有话题(普通群/频道)");
          return;
        }
        if (action === "save-target") {
          const chat = (dialog.querySelector('[name="target_chat"]')?.value || "").trim();
          if (!chat) {
            setStatus("warn", "请选群或手填 -100... 群 ID");
            return;
          }
          const topic = (dialog.querySelector('[name="target_topic_id"]')?.value || "").trim();
          setStatus("info", "正在保存采集来源…");
          await ensureSaveAccountTarget(localId, chat, topic);
          const collectNow = dialog.querySelector("[data-listen-collect-now]")?.checked;
          if (collectNow) {
            setStatus("info", "保存成功,正在切到采集账号…");
            const result = await postJson("/api/accounts/listener/start", { local_id: localId });
            if (!result.ok && result.listener?.status === "error") {
              throw new Error(result.listener.message || "启动采集失败");
            }
            setStatus("ok", "已开始采集,新消息会落到消息箱");
          } else {
            setStatus("ok", "采集来源已保存。回到 sidebar 把账号开关打开就开始采集。");
          }
          await loadAccounts();
          await loadIdentities();
          return;
        }
      } catch (error) {
        setStatus("error", error.message || "操作失败");
      } finally {
        button.disabled = false;
      }
    });
  });
}

async function ensureSaveAccountTarget(localId, targetChat, targetTopicId) {
  const account = state.accounts.find((a) => a.local_id === localId) || {};
  const payload = {
    ...account,
    local_id: localId,
    target_chat: targetChat,
    target_topic_id: targetTopicId || "",
    api_hash: "",
    proxy_password: "",
  };
  return postJson("/api/accounts", payload);
}

function dialogKindLabel(kind) {
  if (kind === "supergroup") return "超级群";
  if (kind === "channel") return "频道";
  if (kind === "group") return "群";
  return "会话";
}

function bindIdentityControls() {
  const identityForm = document.querySelector("#identityForm");
  if (!identityForm) {
    return;
  }
  const sendAsSection = document.querySelector(".send-as-section");

  identityForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveIdentity(identityPayloadFromForm(identityForm));
      state.settingsNotice = "身份已保存";
      renderSettings(state.settings || (await loadSettings()));
    } catch (error) {
      state.settingsNotice = error.message;
      renderSettings(state.settings || {});
    }
  });

  identityForm.querySelectorAll("[data-identity-form-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.identityFormAction;
      if (action === "clear") {
        identityForm.reset();
        identityForm.querySelector('[name="enabled"]').checked = true;
        return;
      }
      if (action === "hydrate") {
        await hydrateIdentityForm(identityForm, button);
        return;
      }
    });
  });

  if (sendAsSection) {
    sendAsSection.querySelectorAll("[data-send-as-action]").forEach((button) => {
      button.addEventListener("click", async () => {
        const action = button.dataset.sendAsAction;
        if (action === "load") {
          await loadSendAsListIntoForm(sendAsSection, button);
          return;
        }
        if (action === "select-all") {
          selectAllSendAs(sendAsSection, "all");
          return;
        }
        if (action === "select-none") {
          selectAllSendAs(sendAsSection, "none");
          return;
        }
        if (action === "batch-save") {
          await batchSaveSelectedSendAs(sendAsSection, button);
          return;
        }
      });
    });
  }

  detailPanel.querySelectorAll("[data-identity-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const sendAsId = Number(button.dataset.identityId || 0);
      const identity = state.identities.find((item) => Number(item.send_as_id) === sendAsId);
      if (!identity) {
        return;
      }
      try {
        if (button.dataset.identityAction === "fill") {
          fillIdentityForm(identity);
          identityForm.scrollIntoView({ block: "nearest" });
          return;
        }
        if (button.dataset.identityAction === "delete") {
          const result = await postJson("/api/identities/delete", { send_as_id: sendAsId });
          if (!result.ok) {
            throw new Error(result.error || "删除身份失败");
          }
          state.settingsNotice = "身份已删除";
          await loadIdentities();
          renderSettings(state.settings || (await loadSettings()));
        }
      } catch (error) {
        state.settingsNotice = error.message;
        renderSettings(state.settings || {});
      }
    });
  });
}

async function loadSendAsListIntoForm(rootEl, button) {
  const accountSelect = rootEl.querySelector('[data-send-as-field="account"]');
  const targetChatInput = rootEl.querySelector('[data-send-as-field="target_chat"]');
  const status = rootEl.querySelector("[data-send-as-status]");
  const result = rootEl.querySelector("[data-send-as-result]");
  if (result) {
    result.hidden = true;
    result.innerHTML = "";
  }
  const localId = accountSelect?.value || "";
  if (!localId) {
    if (status) status.textContent = "请先选账号";
    return;
  }
  const targetChat = (targetChatInput?.value || "").trim();
  button.disabled = true;
  if (status) status.textContent = "正在拉取…";
  state.sendAs = { peers: [], accountLocalId: localId, selected: new Set() };
  rerenderSendAsList(rootEl);
  try {
    const params = new URLSearchParams({ local_id: localId });
    if (targetChat) {
      params.set("target_chat", targetChat);
    }
    const payload = await fetchJson(`/api/accounts/send-as-peers?${params.toString()}`);
    if (!payload.ok) {
      throw new Error(payload.error || "获取可用身份失败");
    }
    state.sendAs = {
      peers: payload.peers || [],
      accountLocalId: localId,
      selected: new Set(),
    };
    // 默认勾选所有还没添加的 peer,符合「批量添加」的常见预期
    state.sendAs.peers.forEach((peer) => {
      if (!isSendAsAlreadyRegistered(peer)) {
        state.sendAs.selected.add(String(peer.send_as_id));
      }
    });
    rerenderSendAsList(rootEl);
    if (status) {
      const total = state.sendAs.peers.length;
      const fresh = state.sendAs.peers.filter((peer) => !isSendAsAlreadyRegistered(peer)).length;
      status.textContent = total
        ? `共 ${total} 个可选身份,其中 ${fresh} 个未添加。默认已勾选未添加的;按需调整后点「保存选中」。`
        : "该账号当前在该群没有可用 send_as 身份";
    }
  } catch (error) {
    if (status) status.textContent = error.message;
    rerenderSendAsList(rootEl);
  } finally {
    button.disabled = false;
  }
}

function isSendAsAlreadyRegistered(peer) {
  if (!peer || peer.send_as_id === undefined || peer.send_as_id === null) {
    return false;
  }
  const id = Number(peer.send_as_id);
  return state.identities.some((identity) => Number(identity.send_as_id) === id);
}

function rerenderSendAsList(rootEl) {
  const list = rootEl.querySelector("[data-send-as-list]");
  const bulkBar = rootEl.querySelector(".send-as-bulk-bar");
  const summary = rootEl.querySelector("[data-send-as-summary]");
  const peers = state.sendAs.peers || [];
  if (!peers.length) {
    if (list) list.innerHTML = "";
    if (bulkBar) bulkBar.hidden = true;
    return;
  }
  if (list) {
    list.innerHTML = peers
      .map((peer) => renderSendAsRow(peer))
      .join("");
    list.querySelectorAll('input[type="checkbox"][data-send-as-checkbox]').forEach((cb) => {
      cb.addEventListener("change", () => {
        const id = cb.dataset.sendAsCheckbox;
        if (cb.checked) {
          state.sendAs.selected.add(id);
        } else {
          state.sendAs.selected.delete(id);
        }
        updateSendAsBulkSummary(rootEl);
      });
    });
    list.querySelectorAll("[data-send-as-fill]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.sendAsFill;
        const peer = peers.find((item) => String(item.send_as_id) === id);
        if (!peer) return;
        const form = rootEl.parentElement?.querySelector("#identityForm")
          || document.querySelector("#identityForm");
        if (!form) return;
        const set = (name, value) => {
          const field = form.querySelector(`[name="${name}"]`);
          if (field) field.value = value ?? "";
        };
        set("send_as_id", peer.send_as_id);
        set("label", peer.title);
        set("username", peer.username);
        set("account_local_id", state.sendAs.accountLocalId);
        form.querySelector('[name="send_as_id"]')?.focus();
      });
    });
  }
  if (bulkBar) {
    bulkBar.hidden = false;
  }
  updateSendAsBulkSummary(rootEl);
}

function renderSendAsRow(peer) {
  const id = String(peer.send_as_id);
  const already = isSendAsAlreadyRegistered(peer);
  const checked = state.sendAs.selected.has(id);
  const kind = peer.kind === "self"
    ? "self"
    : peer.kind === "channel" || peer.kind === "supergroup"
      ? "channel"
      : "self_unbound";
  const tag = identityKindLabel(kind);
  const username = peer.username ? `@${peer.username}` : "";
  const premium = peer.premium_required ? '<span class="status-pill warn">需 Premium</span>' : "";
  const alreadyBadge = already ? '<span class="status-pill ok">已添加</span>' : "";
  return `
    <label class="send-as-row${already ? " disabled" : ""}">
      <input type="checkbox" data-send-as-checkbox="${escapeAttr(id)}"
        ${checked ? "checked" : ""} ${already ? "disabled" : ""} />
      <span class="send-as-row-body">
        <span class="send-as-row-title">
          <strong>${escapeHtml(peer.title || id)}</strong>
          ${username ? `<small>${escapeHtml(username)}</small>` : ""}
        </span>
        <span class="send-as-row-meta">
          <span class="identity-kind ${escapeAttr(kind)}">${escapeHtml(tag)}</span>
          ｜send_as ${escapeHtml(id)}
          ${premium ? `｜${premium}` : ""}
          ${alreadyBadge ? `｜${alreadyBadge}` : ""}
        </span>
      </span>
      <button type="button" class="send-as-row-fill" data-send-as-fill="${escapeAttr(id)}" title="把这条填到下方编辑表单">编辑</button>
    </label>
  `;
}

function updateSendAsBulkSummary(rootEl) {
  const summary = rootEl.querySelector("[data-send-as-summary]");
  const saveButton = rootEl.querySelector('[data-send-as-action="batch-save"]');
  const peers = state.sendAs.peers || [];
  const selectableCount = peers.filter((peer) => !isSendAsAlreadyRegistered(peer)).length;
  const selectedCount = peers.filter(
    (peer) => !isSendAsAlreadyRegistered(peer) && state.sendAs.selected.has(String(peer.send_as_id))
  ).length;
  if (summary) {
    summary.textContent = `已勾选 ${selectedCount} / 可添加 ${selectableCount}`;
  }
  if (saveButton) {
    saveButton.disabled = selectedCount === 0;
    saveButton.textContent = selectedCount > 0 ? `保存选中 (${selectedCount})` : "保存选中";
  }
}

function selectAllSendAs(rootEl, mode) {
  const peers = state.sendAs.peers || [];
  if (mode === "all") {
    peers.forEach((peer) => {
      if (!isSendAsAlreadyRegistered(peer)) {
        state.sendAs.selected.add(String(peer.send_as_id));
      }
    });
  } else {
    state.sendAs.selected.clear();
  }
  rerenderSendAsList(rootEl);
}

async function batchSaveSelectedSendAs(rootEl, button) {
  const peers = state.sendAs.peers || [];
  const localId = state.sendAs.accountLocalId;
  const result = rootEl.querySelector("[data-send-as-result]");
  const status = rootEl.querySelector("[data-send-as-status]");
  if (!localId) {
    if (status) status.textContent = "请先获取可用身份";
    return;
  }
  const targets = peers.filter(
    (peer) => !isSendAsAlreadyRegistered(peer) && state.sendAs.selected.has(String(peer.send_as_id))
  );
  if (!targets.length) {
    if (status) status.textContent = "还没勾选任何未添加的身份";
    return;
  }
  button.disabled = true;
  const original = button.textContent;
  button.textContent = `保存中… (${targets.length})`;
  try {
    const payload = {
      identities: targets.map((peer) => ({
        send_as_id: peer.send_as_id,
        account_local_id: localId,
        label: peer.title || "",
        username: peer.username || "",
        enabled: true,
      })),
    };
    const response = await postJson("/api/identities/batch", payload);
    await loadIdentities();
    renderBatchSaveResult(result, response, peers);
    state.sendAs.selected.clear();
    rerenderSendAsList(rootEl);
    if (status) {
      status.textContent = `本次保存:成功 ${response.saved || 0} / 共 ${response.total || targets.length}。已添加的会自动锁定。`;
    }
  } catch (error) {
    if (result) {
      result.hidden = false;
      result.innerHTML = `<p class="error">${escapeHtml(error.message || "批量保存失败")}</p>`;
    }
  } finally {
    button.disabled = false;
    button.textContent = original;
    updateSendAsBulkSummary(rootEl);
  }
}

function renderBatchSaveResult(container, response, peers) {
  if (!container) return;
  if (!response || !Array.isArray(response.results) || response.results.length === 0) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  const peerById = new Map(peers.map((peer) => [String(peer.send_as_id), peer]));
  const items = response.results.map((entry) => {
    const peer = peerById.get(String(entry.send_as_id ?? ""));
    const title = peer ? (peer.title || peer.send_as_id) : (entry.send_as_id ?? "未知 ID");
    if (entry.ok) {
      return `<li class="ok">✓ ${escapeHtml(String(title))}</li>`;
    }
    return `<li class="warn">✗ ${escapeHtml(String(title))} — ${escapeHtml(entry.error || "保存失败")}</li>`;
  });
  container.hidden = false;
  container.innerHTML = `
    <p>批量保存结果:成功 ${response.saved || 0} / 共 ${response.total || response.results.length}</p>
    <ul class="send-as-result-list">${items.join("")}</ul>
  `;
}

async function hydrateIdentityForm(identityForm, button) {
  const status = document.querySelector("[data-send-as-status]");
  const sendAsValue = identityForm.querySelector('[name="send_as_id"]').value.trim();
  const localId = identityForm.querySelector('[name="account_local_id"]').value
    || document.querySelector('[data-send-as-field="account"]')?.value
    || "";
  if (!sendAsValue || !localId) {
    if (status) status.textContent = "解析需要先填 send_as_id 并选账号";
    return;
  }
  button.disabled = true;
  if (status) status.textContent = "正在用 Telegram 解析…";
  try {
    const result = await postJson("/api/accounts/resolve-entity", {
      local_id: localId,
      send_as_id: Number(sendAsValue),
    });
    if (!result.ok) {
      throw new Error(result.error || "解析失败");
    }
    const labelInput = identityForm.querySelector('[name="label"]');
    const usernameInput = identityForm.querySelector('[name="username"]');
    if (labelInput && !labelInput.value) labelInput.value = result.label || "";
    if (usernameInput && !usernameInput.value) usernameInput.value = result.username || "";
    if (status) status.textContent = `已解析:${result.label || result.username || result.send_as_id}`;
  } catch (error) {
    if (status) status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function identityPayloadFromForm(form) {
  const data = new FormData(form);
  return {
    send_as_id: data.get("send_as_id"),
    account_local_id: data.get("account_local_id"),
    label: data.get("label"),
    username: data.get("username"),
    note: data.get("note"),
    enabled: data.get("enabled") === "on",
  };
}

function fillIdentityForm(identity) {
  const form = document.querySelector("#identityForm");
  if (!form) {
    return;
  }
  const values = {
    send_as_id: identity.send_as_id || "",
    account_local_id: identity.account_local_id || "",
    label: identity.label || "",
    username: identity.username || "",
    note: identity.note || "",
  };
  Object.entries(values).forEach(([key, value]) => {
    const field = form.querySelector(`[name="${key}"]`);
    if (field) {
      field.value = value;
    }
  });
  const enabled = form.querySelector('[name="enabled"]');
  if (enabled) {
    enabled.checked = Boolean(identity.enabled);
  }
}

function renderDialogOptions(targetChat) {
  const selected = String(targetChat || "");
  const knownIds = new Set(state.telegramDialogs.map((item) => String(item.id)));
  const currentOption =
    selected && !knownIds.has(selected)
      ? `<option value="${escapeAttr(selected)}" selected>当前手填：${escapeHtml(selected)}</option>`
      : "";
  const options = state.telegramDialogs
    .map((dialog) => {
      const value = String(dialog.id || "");
      const username = dialog.username ? `｜@${dialog.username}` : "";
      const label = `${dialog.title || value}｜${telegramDialogKindLabel(dialog.kind)}｜${value}${username}`;
      return `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
  return `${currentOption}${options}`;
}

function renderTopicOptions(targetTopicId) {
  const selected = String(targetTopicId || "");
  const knownIds = new Set(state.telegramTopics.map((item) => String(item.id)));
  const currentOption =
    selected && !knownIds.has(selected)
      ? `<option value="${escapeAttr(selected)}" selected>当前手填：${escapeHtml(selected)}</option>`
      : "";
  const options = state.telegramTopics
    .map((topic) => {
      const value = String(topic.id || "");
      const label = `${topic.title || value}｜${value}`;
      return `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`;
    })
    .join("");
  return `${currentOption}${options}`;
}

function telegramDialogKindLabel(kind) {
  if (kind === "supergroup") {
    return "超级群";
  }
  if (kind === "channel") {
    return "频道";
  }
  if (kind === "group") {
    return "群";
  }
  return "会话";
}

async function saveCurrentSettingsFromForm(form) {
  const data = new FormData(form);
  return saveSettings({
    api_id: data.get("api_id"),
    api_hash: data.get("api_hash"),
    phone: data.get("phone"),
    session_name: data.get("session_name"),
    target_chat: data.get("target_chat"),
    target_topic_id: data.get("target_topic_id"),
    game_bot_ids: String(data.get("game_bot_ids") || "")
      .split(/\n|,/)
      .map((item) => item.trim())
      .filter(Boolean),
    proxy_type: data.get("proxy_type"),
    proxy_host: data.get("proxy_host"),
    proxy_username: data.get("proxy_username"),
    proxy_password: data.get("proxy_password"),
  });
}

async function postJson(url, payload) {
  const response = await apiFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`请求失败：${response.status}`);
  }
  return response.json();
}

selectAllChannels.addEventListener("click", () => {
  if (state.selectedChannels.size === state.channels.length) {
    state.selectedChannels.clear();
  } else {
    state.selectedChannels = new Set(state.channels.map((channel) => channel.key));
  }
  state.selectedMessageId = visibleMessages()[0]?.id ?? null;
  state.detailMode = "message";
  renderChannelFilters();
  renderMessages();
  renderDetail();
});

// viewMode 切换在主界面已下线 — 默认 solo,「全部」走顶部「日志」按钮的 modal。
// setViewMode 留给跳转跨视图等内部调用,但不再绑按钮。
function setViewMode(mode) {
  if (mode !== "solo") return;  // 只支持 solo;全部走 logs modal
  if (state.viewMode === mode) return;
  state.viewMode = mode;
  state.detailMode = "message";
  if (!visibleMessages().some((m) => m.id === state.selectedMessageId)) {
    state.selectedMessageId = visibleMessages()[0]?.id ?? null;
  }
  renderMessages();
  renderDetail();
}

if (jumpToLatestButton && messageList) {
  const updateJumpButton = () => {
    if (!jumpToLatestButton) return;
    jumpToLatestButton.hidden = messageList.scrollTop <= 100;
  };
  messageList.addEventListener("scroll", updateJumpButton, { passive: true });
  jumpToLatestButton.addEventListener("click", () => {
    state.detailMode = "message";
    state.selectedMessageId = visibleMessages()[0]?.id ?? null;
    messageList.scrollTo({ top: 0, behavior: "smooth" });
    renderDetail();
  });
}

refreshButton.addEventListener("click", async () => {
  if (state.refreshState === "loading") {
    return;
  }
  state.refreshState = "loading";
  const original = refreshButton.textContent;
  refreshButton.textContent = "正在刷新…";
  refreshButton.disabled = true;
  try {
    await Promise.all([loadMessages(), loadIdentityPatches()]);
    if (state.detailMode === "drafts") {
      await renderOutboxDraftsView();
    }
  } catch (error) {
    showError(error);
  } finally {
    state.refreshState = "idle";
    refreshButton.textContent = original;
    refreshButton.disabled = false;
  }
});

outboxButton.addEventListener("click", async () => {
  state.detailMode = "drafts";
  try {
    await renderOutboxDraftsView();
  } catch (error) {
    showError(error);
  }
});

scheduleButton.addEventListener("click", async () => {
  try {
    await Promise.all([loadAccounts(), loadIdentities()]);
    await openScheduleModal();
  } catch (error) {
    showError(error);
  }
});

if (loginAccountButton) {
  loginAccountButton.addEventListener("click", async () => {
    console.log("[mini-web] login button clicked");
    try {
      await loadAccounts();
      console.log("[mini-web] loadAccounts done, opening modal");
      openAccountModal(null);
      console.log("[mini-web] openAccountModal returned");
    } catch (error) {
      console.error("[mini-web] login click failed:", error);
      showError(error);
    }
  });
} else {
  console.warn("[mini-web] loginAccountButton not found at bind time");
}

if (addIdentityButton) {
  addIdentityButton.addEventListener("click", async () => {
    console.log("[mini-web] add-identity clicked");
    try {
      await Promise.all([loadAccounts(), loadIdentities()]);
      openAddIdentityModal();
    } catch (error) {
      console.error("[mini-web] add-identity failed:", error);
      showError(error);
    }
  });
} else {
  console.warn("[mini-web] addIdentityButton not found at bind time");
}

if (logoutAccountButton) {
  logoutAccountButton.addEventListener("click", async () => {
    console.log("[mini-web] logout clicked");
    try {
      await Promise.all([loadAccounts(), loadIdentities()]);
      openLogoutAccountModal();
    } catch (error) {
      console.error("[mini-web] logout failed:", error);
      showError(error);
    }
  });
} else {
  console.warn("[mini-web] logoutAccountButton not found at bind time");
}

if (gameBotsButton) {
  gameBotsButton.addEventListener("click", () => openGameBotsModal());
}

if (logsButton) {
  logsButton.addEventListener("click", () => openLogsModal());
}

// 「日志」按钮 — 老脚本风格的全量消息浏览。
// 主界面默认 solo 视图(只我和天尊),全部消息靠这个 modal 看。
// 接口直接打 /api/messages?channel=...,不带 mode → server 返完整列表。
async function openLogsModal() {
  const dialog = openModal({
    title: "消息日志(全部采集)",
    body: `
      <section class="modal-section">
        <div class="form-grid">
          <label class="span-2">
            <span>频道</span>
            <select id="logsChannelSelect">
              <option value="all" selected>全部频道</option>
              ${(state.channels || []).map((c) => `<option value="${escapeAttr(c.key)}">${escapeHtml(c.label || c.key)}</option>`).join("")}
            </select>
          </label>
          <label>
            <span>关键字过滤</span>
            <input id="logsSearch" placeholder="文本子串,空 = 不过滤" />
          </label>
          <label>
            <span>每页</span>
            <select id="logsPageSize">
              <option value="100">100 条</option>
              <option value="200" selected>200 条</option>
              <option value="500">500 条</option>
            </select>
          </label>
        </div>
        <div class="form-actions">
          <button type="button" id="logsRefresh">重新加载</button>
          <button type="button" id="logsLoadMore">加载更早</button>
          <span class="muted" style="flex:1"></span>
          <select id="logsExportFmt" title="导出格式">
            <option value="jsonl" selected>jsonl</option>
            <option value="csv">csv</option>
            <option value="txt">txt</option>
          </select>
          <button type="button" id="logsExport" title="导出当前频道全部消息(无 limit)">导出</button>
          <span id="logsStatus" class="muted"></span>
        </div>
      </section>
      <section class="modal-section">
        <div id="logsList" class="logs-modal-list"></div>
      </section>
    `,
    footer: `<button type="button" data-modal-close>关闭</button>`,
  });
  if (!dialog) return;
  bindLogsModal(dialog);
}

function bindLogsModal(dialog) {
  const channelSelect = dialog.querySelector("#logsChannelSelect");
  const searchInput = dialog.querySelector("#logsSearch");
  const pageSizeSelect = dialog.querySelector("#logsPageSize");
  const refreshBtn = dialog.querySelector("#logsRefresh");
  const loadMoreBtn = dialog.querySelector("#logsLoadMore");
  const statusEl = dialog.querySelector("#logsStatus");
  const listEl = dialog.querySelector("#logsList");
  if (!listEl) return;

  // 内部状态:游标用「最早一条 seq」往下翻
  const local = { items: [], oldestSeq: 0, loading: false };

  const setStatus = (text) => { statusEl.textContent = text || ""; };

  const fetchPage = async ({ reset = false } = {}) => {
    if (local.loading) return;
    local.loading = true;
    refreshBtn.disabled = true;
    loadMoreBtn.disabled = true;
    setStatus("加载中…");
    try {
      const params = new URLSearchParams({ channel: channelSelect.value || "all" });
      const limit = pageSizeSelect.value || "200";
      params.set("limit", limit);
      if (!reset && local.oldestSeq > 0) {
        params.set("before_seq", String(local.oldestSeq));
      }
      const result = await fetchJson(`/api/messages?${params.toString()}`);
      let incoming = result.messages || [];
      const q = (searchInput.value || "").trim();
      if (q) incoming = incoming.filter((m) => (m.raw || m.summary || "").includes(q));
      if (reset) {
        local.items = incoming;
      } else {
        local.items = local.items.concat(incoming);
      }
      const oldest = incoming.reduce((min, m) => (min === 0 || (m.seq && m.seq < min) ? m.seq : min), 0);
      if (oldest > 0) local.oldestSeq = oldest;
      renderLogs(listEl, local.items);
      setStatus(`已加载 ${local.items.length} 条${incoming.length === 0 && !reset ? "(无更早)" : ""}`);
    } catch (err) {
      setStatus(`错误:${err.message}`);
    } finally {
      local.loading = false;
      refreshBtn.disabled = false;
      loadMoreBtn.disabled = false;
    }
  };

  refreshBtn.addEventListener("click", () => {
    local.oldestSeq = 0;
    fetchPage({ reset: true });
  });
  loadMoreBtn.addEventListener("click", () => fetchPage({ reset: false }));
  channelSelect.addEventListener("change", () => {
    local.oldestSeq = 0;
    fetchPage({ reset: true });
  });
  pageSizeSelect.addEventListener("change", () => {
    local.oldestSeq = 0;
    fetchPage({ reset: true });
  });
  searchInput.addEventListener("input", () => {
    // 只 client side 过滤已加载内容,避免 server 频繁查
    let items = local.items;
    const q = (searchInput.value || "").trim();
    if (q) items = items.filter((m) => (m.raw || m.summary || "").includes(q));
    renderLogs(listEl, items);
  });

  // 导出当前频道全部(无 limit) — 浏览器走 fetch + Blob → a.download。
  // 没在 modal 里再过滤 search/pageSize,因为「谁爱看谁自己拿出来读」 — 全量交付。
  const exportBtn = dialog.querySelector("#logsExport");
  const exportFmt = dialog.querySelector("#logsExportFmt");
  if (exportBtn) {
    exportBtn.addEventListener("click", async () => {
      const fmt = exportFmt.value || "jsonl";
      const params = new URLSearchParams({
        channel: channelSelect.value || "all",
        fmt,
      });
      exportBtn.disabled = true;
      const oldText = exportBtn.textContent;
      exportBtn.textContent = "导出中…";
      setStatus("拉取全量数据,大批可能要几秒…");
      try {
        const url = `/api/messages/export?${params.toString()}`;
        const headers = {};
        if (window.MINIWEB_TOKEN) headers["X-Miniweb-Token"] = window.MINIWEB_TOKEN;
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const cd = res.headers.get("Content-Disposition") || "";
        const m = cd.match(/filename="([^"]+)"/);
        const filename = m ? m[1] : `xiuxian-messages.${fmt}`;
        const downloadUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = downloadUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(downloadUrl);
        setStatus(`已导出 ${filename}｜${(blob.size / 1024).toFixed(1)} KB`);
      } catch (err) {
        setStatus(`导出失败:${err.message}`);
      } finally {
        exportBtn.disabled = false;
        exportBtn.textContent = oldText;
      }
    });
  }

  fetchPage({ reset: true });
}

function renderLogs(container, items) {
  if (!items.length) {
    container.innerHTML = '<p class="empty inline">无匹配消息</p>';
    return;
  }
  container.innerHTML = items.map((m) => {
    const time = (m.time || "").replace("T", " ").replace(/\..+$/, "").replace(/\+.+$/, "");
    const sender = m.sender_id || "";
    const channel = m.channel || "";
    const raw = (m.raw || m.summary || "").trim();
    return `
      <article class="logs-row">
        <div class="logs-row-meta">
          <small>${escapeHtml(time)}</small>
          <span class="logs-row-channel">${escapeHtml(channel)}</span>
          <small>from ${escapeHtml(String(sender))}</small>
        </div>
        <pre class="logs-row-text">${escapeHtml(raw)}</pre>
      </article>
    `;
  }).join("");
}

loadChannels()
  .then(loadSettings)
  .then(loadAccounts)
  .then(loadIdentities)
  .then(loadIdentityPatches)
  .then(loadDiscoveredBots)
  .then(loadMessages)
  .catch(showError);

// 自动轮询消息流(只在 chat 视图 + 页面可见时拉,避免 tab 切走还在打)。
// listener 持续 ingest 新消息进 SQLite,这里负责把它们端到 UI。
const POLL_INTERVAL_MS = 5000;
let pollTimer = null;
let pollInflight = false;

async function pollTick() {
  if (pollInflight) return;
  if (document.hidden) return;
  if (state.refreshState === "loading") return;
  pollInflight = true;
  try {
    // 即使用户切到草稿箱/官方定时视图,后台也继续把新消息 merge 进 state,
    // 这样切回 chat 时立刻看见最新的。listener 写得很快,前端再不跟就脱节。
    await Promise.all([
      loadMessages({ incremental: true }),
      loadAccounts(),
      loadDiscoveredBots(),
    ]);
    // 玩法状态机摘要每 ~6 个 tick(~30s)刷一次,纯展示,不阻塞主链。
    pollTickCount = (pollTickCount + 1) % 6;
    if (pollTickCount === 0) {
      loadIdentityModuleStates().catch(() => {});
    }
  } catch (error) {
    console.warn("[mini-web] poll tick failed:", error);
  } finally {
    pollInflight = false;
  }
}
let pollTickCount = 0;

function startPolling() {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(pollTick, POLL_INTERVAL_MS);
  // module chip 每秒倒计时本地 tick(不走网络),独立于 polling
  if (window._moduleChipTimer == null) {
    window._moduleChipTimer = window.setInterval(tickIdentityModuleChips, 1000);
  }
}

function stopPolling() {
  if (pollTimer === null) return;
  window.clearInterval(pollTimer);
  pollTimer = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopPolling();
  } else {
    pollTick();
    startPolling();
  }
});

startPolling();
