// MINIWEB-MODULE: formatting and escaping helpers
(function () {
  "use strict";

  const GRAPHEME_SEGMENTER =
    typeof Intl !== "undefined" && Intl.Segmenter
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;

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

  function graphemes(value) {
    const text = String(value ?? "");
    if (!text) return [];
    if (GRAPHEME_SEGMENTER) {
      return Array.from(GRAPHEME_SEGMENTER.segment(text), (part) => part.segment);
    }
    return Array.from(text);
  }

  function countGraphemes(value) {
    return graphemes(value).length;
  }

  function clipGraphemes(value, limit) {
    const parts = graphemes(value);
    if (parts.length <= limit) return String(value ?? "");
    return parts.slice(0, limit).join("");
  }

  function firstGrapheme(value) {
    return graphemes(value)[0] || "";
  }

  function formatNumber(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return String(value || 0);
    return new Intl.NumberFormat("zh-CN").format(n);
  }

  window.MiniwebFormat = {
    clipGraphemes,
    countGraphemes,
    escapeAttr,
    escapeHtml,
    firstGrapheme,
    formatNumber,
    graphemes,
  };
})();
