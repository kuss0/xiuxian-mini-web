// MINIWEB-MODULE: Lightweight module loader
// 为 app.js 提供模块化支持，无需重写现有代码
(function() {
  "use strict";

  /**
   * 模块注册表
   */
  const modules = new Map();

  /**
   * 注册模块
   * @param {string} name - 模块名
   * @param {Object} exports - 导出对象
   */
  function register(name, exports) {
    if (modules.has(name)) {
      console.warn(`[mini-web] Module "${name}" already registered, overwriting`);
    }
    modules.set(name, exports);
    console.log(`[mini-web] Module "${name}" registered`);
  }

  /**
   * 获取模块
   * @param {string} name - 模块名
   * @returns {Object} 模块导出
   */
  function require(name) {
    if (!modules.has(name)) {
      throw new Error(`[mini-web] Module "${name}" not found`);
    }
    return modules.get(name);
  }

  /**
   * 检查模块是否已注册
   * @param {string} name - 模块名
   * @returns {boolean}
   */
  function has(name) {
    return modules.has(name);
  }

  /**
   * 列出所有已注册的模块
   * @returns {Array<string>}
   */
  function list() {
    return Array.from(modules.keys());
  }

  /**
   * 等待所有模块加载完成
   * @param {Array<string>} moduleNames - 模块名列表
   * @param {number} timeout - 超时时间(ms)
   * @returns {Promise<void>}
   */
  function waitFor(moduleNames, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      function check() {
        const allLoaded = moduleNames.every(name => modules.has(name));

        if (allLoaded) {
          resolve();
        } else if (Date.now() - startTime > timeout) {
          const missing = moduleNames.filter(name => !modules.has(name));
          reject(new Error(`[mini-web] Timeout waiting for modules: ${missing.join(', ')}`));
        } else {
          setTimeout(check, 50);
        }
      }

      check();
    });
  }

  // 导出到全局
  window.MiniwebModules = {
    register,
    require,
    has,
    list,
    waitFor,
  };

  console.log('[mini-web] Module loader initialized');
})();
