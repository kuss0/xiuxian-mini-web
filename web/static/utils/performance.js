// MINIWEB-UTIL: Performance optimization utilities
(function () {
  "use strict";

  /**
   * 防抖函数 - 延迟执行，只执行最后一次
   * @param {Function} func - 要防抖的函数
   * @param {number} wait - 等待时间(ms)
   * @returns {Function} 防抖后的函数
   */
  function debounce(func, wait = 300) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  /**
   * 节流函数 - 限制执行频率
   * @param {Function} func - 要节流的函数
   * @param {number} limit - 时间限制(ms)
   * @returns {Function} 节流后的函数
   */
  function throttle(func, limit = 300) {
    let inThrottle;
    return function executedFunction(...args) {
      if (!inThrottle) {
        func(...args);
        inThrottle = true;
        setTimeout(() => (inThrottle = false), limit);
      }
    };
  }

  /**
   * requestAnimationFrame 包装的节流
   * 用于 DOM 更新操作
   */
  function rafThrottle(func) {
    let rafId = null;
    return function executedFunction(...args) {
      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          func(...args);
          rafId = null;
        });
      }
    };
  }

  /**
   * 批量 DOM 更新 - 使用 DocumentFragment
   */
  function batchDomUpdate(container, renderFn) {
    const fragment = document.createDocumentFragment();
    renderFn(fragment);
    container.innerHTML = "";
    container.appendChild(fragment);
  }

  window.MiniwebPerformance = {
    debounce,
    throttle,
    rafThrottle,
    batchDomUpdate,
  };
})();
