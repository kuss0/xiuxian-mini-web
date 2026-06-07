// MINIWEB-MODULE: formatting and escaping helpers
(function () {
  "use strict";

  const GRAPHEME_SEGMENTER =
    typeof Intl !== "undefined" && Intl.Segmenter
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
  const DISPLAY_TIME_ZONE = "Asia/Shanghai";
  const DISPLAY_DATE_TIME_FORMAT =
    typeof Intl !== "undefined" && Intl.DateTimeFormat
      ? new Intl.DateTimeFormat("zh-CN", {
          timeZone: DISPLAY_TIME_ZONE,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        })
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

  function parseDateValue(value) {
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value;
    }
    const text = String(value || "").trim();
    if (!text) return null;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function displayTimeParts(value) {
    const date = parseDateValue(value);
    if (!date) return null;
    if (!DISPLAY_DATE_TIME_FORMAT) {
      return {
        year: String(date.getFullYear()),
        month: String(date.getMonth() + 1).padStart(2, "0"),
        day: String(date.getDate()).padStart(2, "0"),
        hour: String(date.getHours()).padStart(2, "0"),
        minute: String(date.getMinutes()).padStart(2, "0"),
      };
    }
    const parts = {};
    DISPLAY_DATE_TIME_FORMAT.formatToParts(date).forEach((part) => {
      if (part.type !== "literal") parts[part.type] = part.value;
    });
    return {
      year: parts.year || "",
      month: parts.month || "",
      day: parts.day || "",
      hour: parts.hour || "",
      minute: parts.minute || "",
    };
  }

  function formatDisplayClockTime(value) {
    const parts = displayTimeParts(value);
    return parts ? `${parts.hour}:${parts.minute}` : "";
  }

  function formatDisplayMonthDayTime(value) {
    const parts = displayTimeParts(value);
    return parts ? `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}` : "";
  }

  function formatDisplayDateTime(value) {
    const parts = displayTimeParts(value);
    return parts ? `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}` : "";
  }

  function displayDayIndex(value) {
    const parts = displayTimeParts(value);
    if (!parts) return null;
    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  }

  window.MiniwebFormat = {
    DISPLAY_TIME_ZONE,
    clipGraphemes,
    countGraphemes,
    displayDayIndex,
    displayTimeParts,
    escapeAttr,
    escapeHtml,
    firstGrapheme,
    formatDisplayClockTime,
    formatDisplayDateTime,
    formatDisplayMonthDayTime,
    formatNumber,
    graphemes,
    parseDateValue,
  };
})();
