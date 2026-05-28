// MINIWEB-UTIL: Safe DOM manipulation utilities
(function () {
  "use strict";

  const { escapeHtml, escapeAttr } = window.MiniwebFormat || {};

  if (!escapeHtml) {
    console.error('[mini-web] MiniwebFormat not loaded, safe-dom cannot initialize');
    return;
  }

  /**
   * 安全地设置元素的文本内容
   * 使用 textContent 避免 XSS
   *
   * @param {HTMLElement} element - 目标元素
   * @param {string} text - 文本内容
   */
  function setText(element, text) {
    if (!element) return;
    element.textContent = String(text || "");
  }

  /**
   * 安全地设置 HTML 内容（自动转义）
   * 适用于需要显示用户输入但不需要 HTML 格式的场景
   *
   * @param {HTMLElement} element - 目标元素
   * @param {string} html - HTML 内容（会被转义）
   */
  function setHtml(element, html) {
    if (!element) return;
    element.innerHTML = escapeHtml(String(html || ""));
  }

  /**
   * 设置可信的 HTML 内容（不转义）
   * ⚠️ 警告：仅用于已知安全的内容！
   * 使用前必须确认内容来源可信或已经过转义
   *
   * @param {HTMLElement} element - 目标元素
   * @param {string} html - 可信的 HTML 内容
   */
  function setTrustedHtml(element, html) {
    if (!element) return;
    element.innerHTML = String(html || "");
  }

  /**
   * 安全地设置属性值
   *
   * @param {HTMLElement} element - 目标元素
   * @param {string} attr - 属性名
   * @param {string} value - 属性值
   */
  function setAttr(element, attr, value) {
    if (!element || !attr) return;
    element.setAttribute(attr, escapeAttr ? escapeAttr(String(value || "")) : String(value || ""));
  }

  /**
   * 创建安全的文本节点
   *
   * @param {string} text - 文本内容
   * @returns {Text} 文本节点
   */
  function createTextNode(text) {
    return document.createTextNode(String(text || ""));
  }

  /**
   * 批量创建元素并设置安全内容
   *
   * @param {string} tag - 标签名
   * @param {Object} options - 配置选项
   * @param {string} options.text - 文本内容（安全）
   * @param {string} options.html - HTML 内容（会被转义）
   * @param {string} options.trustedHtml - 可信 HTML（不转义）
   * @param {Object} options.attrs - 属性对象
   * @param {string} options.className - CSS 类名
   * @returns {HTMLElement} 创建的元素
   */
  function createElement(tag, options = {}) {
    const element = document.createElement(tag);

    if (options.className) {
      element.className = options.className;
    }

    if (options.attrs) {
      for (const [key, value] of Object.entries(options.attrs)) {
        setAttr(element, key, value);
      }
    }

    if (options.text !== undefined) {
      setText(element, options.text);
    } else if (options.html !== undefined) {
      setHtml(element, options.html);
    } else if (options.trustedHtml !== undefined) {
      setTrustedHtml(element, options.trustedHtml);
    }

    return element;
  }

  window.MiniwebSafeDom = {
    setText,
    setHtml,
    setTrustedHtml,
    setAttr,
    createTextNode,
    createElement,
  };

  console.log('[mini-web] Safe DOM utilities loaded');
})();
