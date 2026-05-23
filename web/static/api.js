// MINIWEB-MODULE: API helpers
(function () {
  "use strict";

  const AUTH_TOKEN_STORAGE_KEY = "xiuxianMiniwebAccessToken";

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

  window.MiniwebApi = {
    apiFetch,
    fetchJson,
    postJson,
  };
})();
