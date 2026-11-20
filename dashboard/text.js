/** @param {any} value */
export function stringValue(value) {
  return typeof value === "string" ? value : "";
}

/** @param {string} text @param {number} max */
export function capText(text, max) {
  return text.length > max
    ? { text: `${text.slice(0, max)}\n…（内容过长，已截断）`, truncated: true }
    : { text, truncated: false };
}
