const state = {
  channels: [],
  activeChannel: "all",
  messages: [],
  selectedMessageId: null,
};

const channelTabs = document.querySelector("#channelTabs");
const messageList = document.querySelector("#messageList");
const messageCount = document.querySelector("#messageCount");
const detailPanel = document.querySelector("#detailPanel");
const refreshButton = document.querySelector("#refreshButton");
const scheduleButton = document.querySelector("#scheduleButton");

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return response.json();
}

async function loadChannels() {
  const payload = await fetchJson("/api/channels");
  state.channels = [{ key: "all", label: "全部", description: "合併展示" }, ...payload.channels];
  renderTabs();
}

async function loadMessages() {
  const payload = await fetchJson(`/api/messages?channel=${encodeURIComponent(state.activeChannel)}`);
  state.messages = payload.messages;
  if (!state.messages.some((message) => message.id === state.selectedMessageId)) {
    state.selectedMessageId = state.messages[0]?.id ?? null;
  }
  renderMessages();
  renderDetail();
}

function renderTabs() {
  channelTabs.replaceChildren(
    ...state.channels.map((channel) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = channel.key === state.activeChannel ? "tab active" : "tab";
      button.textContent = channel.label;
      button.title = channel.description;
      button.addEventListener("click", () => {
        state.activeChannel = channel.key;
        loadMessages().catch(showError);
        renderTabs();
      });
      return button;
    })
  );
}

function renderMessages() {
  messageCount.textContent = `${state.messages.length} 條`;
  if (state.messages.length === 0) {
    messageList.innerHTML = '<p class="empty">暫無消息。</p>';
    return;
  }

  messageList.replaceChildren(
    ...state.messages.map((message) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = message.id === state.selectedMessageId ? "message-card active" : "message-card";
      card.addEventListener("click", () => {
        state.selectedMessageId = message.id;
        renderMessages();
        renderDetail();
      });

      const tags = (message.tags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
      card.innerHTML = `
        <div class="message-meta">
          <strong>${escapeHtml(message.source)}</strong>
          <span>${escapeHtml(message.time)}</span>
        </div>
        <h4>${escapeHtml(message.title)}</h4>
        <p>${escapeHtml(message.summary)}</p>
        <div class="tag-row">${tags}</div>
      `;
      return card;
    })
  );
}

function renderDetail() {
  const message = state.messages.find((item) => item.id === state.selectedMessageId);
  if (!message) {
    detailPanel.innerHTML = '<p class="empty">選擇一條消息查看原文與可用操作。</p>';
    return;
  }

  const actions = (message.actions || [])
    .map(
      (action, index) => `
        <button class="action-button" type="button" data-action-index="${index}">
          <span>${escapeHtml(action.label)}</span>
          <code>${escapeHtml(action.command)}</code>
        </button>
      `
    )
    .join("");

  detailPanel.innerHTML = `
    <div class="detail-block">
      <h4>${escapeHtml(message.title)}</h4>
      <p>${escapeHtml(message.summary)}</p>
    </div>
    <div class="detail-block">
      <h5>原始消息</h5>
      <pre>${escapeHtml(message.raw)}</pre>
    </div>
    <div class="detail-block">
      <h5>可用操作</h5>
      <div class="action-list">${actions || '<p class="empty">沒有可用操作。</p>'}</div>
    </div>
  `;

  detailPanel.querySelectorAll("[data-action-index]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = message.actions[Number(button.dataset.actionIndex)];
      await navigator.clipboard.writeText(action.command);
      button.classList.add("copied");
      button.querySelector("span").textContent = "已複製";
      setTimeout(() => {
        button.classList.remove("copied");
        button.querySelector("span").textContent = action.label;
      }, 1200);
    });
  });
}

function showError(error) {
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

refreshButton.addEventListener("click", () => {
  loadMessages().catch(showError);
});

scheduleButton.addEventListener("click", () => {
  detailPanel.innerHTML = `
    <div class="detail-block">
      <h4>官方定時</h4>
      <p>基座階段先保留入口。後續在這裡查看、建立、刪除 Telegram 官方定時消息。</p>
    </div>
  `;
});

loadChannels()
  .then(loadMessages)
  .catch(showError);

