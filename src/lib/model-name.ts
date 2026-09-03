/**
 * Translate model name from CC format to Copilot catalog format.
 * For native /v1/messages passthrough — only does basic normalization:
 *   - Date suffix stripping (claude-haiku-4-5-20251001 → claude-haiku-4-5)
 *   - [1m] suffix stripping (claude-opus-4-7[1m] → claude-opus-4-7)
 *   - Hyphen → dot (claude-opus-4-7 → claude-opus-4.7)
 *
 * No 1M-internal upgrade — Copilot's /v1/messages natively supports
 * 1M context on base model names (same as Anthropic's official API).
 */
export function translateModelName(model: string): string {
  // Strip date suffixes (e.g. `-20251001`).
  const undated = model.replace(/-\d{8}$/, "")

  // Strip `[1m]` suffix — Copilot /v1/messages doesn't need it.
  const base =
    undated.endsWith("[1m]") ? undated.slice(0, -"[1m]".length) : undated

  // Normalize hyphen form → dot form for the version number only.
  return base.replace(/^(claude-(?:opus|sonnet|haiku)-\d+)-(\d+)/, "$1.$2")
}
