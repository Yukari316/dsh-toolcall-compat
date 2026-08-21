/**
 * Pure display-formatting helpers — no DSH runtime dependencies. Used by the
 * client half; unit-testable without React or a browser.
 */

/** Truncate long display text. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/**
 * Render escape sequences as characters for expanded display.
 *
 * 1. A JSON string literal decodes properly (`"a\nb"` → real newline).
 * 2. Any other JSON value pretty-prints (`{"a":1}` → multi-line).
 * 3. Plain text gets a conservative replacement of the common JSON escapes
 *    (`\n`, `\r`, `\t`, `\"`) — backslashes are left alone so Windows paths
 *    like `C:\Users` are not corrupted.
 */
export function unescapeForDisplay(text: string, max: number): string {
  if (text.length === 0) return text
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed === 'string') return truncate(parsed, max)
    return truncate(JSON.stringify(parsed, null, 2), max)
  } catch {
    // Not a JSON value; fall through to the conservative replacement.
  }
  const replaced = text
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
  return truncate(replaced, max)
}

/** Join text blocks of a settled result's content. */
export function blockText(content: readonly { type: string; text?: string }[] | undefined): string {
  return (content ?? []).map((c) => (c !== null && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string' ? c.text : '')).join('\n')
}

/** Fill `{name}` placeholders with the given params. */
export function fmt(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(params[key] ?? ''))
}

/** Best-effort tool icon glyph, mirroring the shipped per-tool icons. */
export function toolIcon(toolName: string): string {
  if (toolName.startsWith('cordis_')) return '✨'
  switch (toolName) {
    case 'bash':
    case 'pwsh':
      return '💻'
    case 'read':
      return '📄'
    case 'write':
    case 'edit':
      return '✏️'
    case 'glob':
    case 'grep':
      return '🔍'
    case 'web_search':
    case 'web_fetch':
      return '🌐'
    case 'skill':
      return '📘'
    case 'todo_write':
      return '☑️'
    case 'ask_user_question':
      return '❓'
    default:
      return '⚙️'
  }
}
