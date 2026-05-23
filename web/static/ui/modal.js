// MINIWEB-MODULE: modal shell
(function () {
  "use strict";

  let modalCloseHandler = null;

  function openModal({ title, body, footer }) {
    const modalRoot = document.querySelector("#modalRoot");
    if (!modalRoot) return null;
    const { escapeHtml } = window.MiniwebFormat;
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
    const modalRoot = document.querySelector("#modalRoot");
    if (!modalRoot) return;
    modalRoot.hidden = true;
    modalRoot.innerHTML = "";
    if (modalCloseHandler) {
      document.removeEventListener("keydown", modalCloseHandler);
      modalCloseHandler = null;
    }
  }

  window.MiniwebModal = {
    closeModal,
    openModal,
  };
})();
