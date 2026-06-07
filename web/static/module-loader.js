// MINIWEB-UTIL: lightweight module registry for optional shared utilities
(function () {
  "use strict";

  const modules = new Map();

  function register(name, module) {
    const key = String(name || "").trim();
    if (!key) {
      throw new Error("module name is required");
    }
    modules.set(key, module);
    return module;
  }

  function requireModule(name) {
    const key = String(name || "").trim();
    if (!modules.has(key)) {
      throw new Error(`module not registered: ${key}`);
    }
    return modules.get(key);
  }

  function has(name) {
    return modules.has(String(name || "").trim());
  }

  function list() {
    return Array.from(modules.keys()).sort();
  }

  function waitFor(names, timeoutMs = 1000) {
    const expected = (Array.isArray(names) ? names : [names]).map((name) => String(name || "").trim());
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + Number(timeoutMs || 0);
      const check = () => {
        if (expected.every((name) => modules.has(name))) {
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          reject(new Error(`modules not ready: ${expected.filter((name) => !modules.has(name)).join(", ")}`));
          return;
        }
        setTimeout(check, 25);
      };
      check();
    });
  }

  window.MiniwebModules = {
    register,
    require: requireModule,
    has,
    list,
    waitFor,
  };

  console.log("[mini-web] Module loader initialized");
})();
