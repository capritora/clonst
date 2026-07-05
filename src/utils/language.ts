/**
 * language[-Script][-Region] ONLY (e.g. "fr", "pt-BR", "zh-Hans", "zh-Hans-CN").
 * Variant and extension subtags are deliberately excluded: Intl.DisplayNames
 * echoes unknown variants back verbatim ("fr-approved" -> "French (APPROVED)"),
 * which would let a caller inject chosen words into the reviewer prompt (found
 * by a Codex review). Script and Region render only Intl-generated vocabulary.
 */
export const SAFE_LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z]{4})?(-([A-Za-z]{2}|\d{3}))?$/;

/**
 * Resolves a language code ("fr", "pt-BR") into an English language name
 * ("French", "Brazilian Portuguese") through Intl.DisplayNames. The RAW input
 * value never reaches the reviewer prompt: only this resolved name does. The
 * language[-Script][-Region] shape is validated HERE as well as at the entry
 * points (defense in depth: a schema or config change cannot reopen the
 * variant echo hole). Returns undefined for unknown or invalid codes (Intl
 * either echoes the code back or throws): callers then fall back to the
 * default rule (language of the reviewed content).
 */
export function resolveLanguageName(code: string): string | undefined {
  if (!SAFE_LANGUAGE_TAG.test(code)) return undefined;
  try {
    const resolved = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
    if (resolved !== undefined && resolved.toLowerCase() !== code.toLowerCase()) {
      return resolved;
    }
  } catch {
    // structurally invalid tag: fall through to undefined
  }
  return undefined;
}
