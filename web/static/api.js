// MINIWEB-MODULE: API helpers
(function () {
  "use strict";

  async function fetchJson(url) {
    const response = await apiFetch(url);
    if (!response.ok) {
      throw new Error(`请求失败：${response.status}`);
    }
    return response.json();
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

  async function apiFetch(url, options = {}) {
    return fetch(url, options);
  }

  window.MiniwebApi = {
    apiFetch,
    fetchJson,
    postJson,
  };
})();
