// MINIWEB-MODULE: toast helper
(function () {
  "use strict";

  let toastTimer = null;

  function showToast(text, kind) {
    const toast = document.querySelector("#skillToast");
    if (!toast) return;
    toast.textContent = text;
    toast.className = `skill-toast ${kind || ""}`.trim();
    toast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 3200);
  }

  window.MiniwebToast = {
    showToast,
  };
})();
