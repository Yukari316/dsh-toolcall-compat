/**
 * English dictionary, checked complete against the zh key set at compile time
 * (`Record<LocaleKey, string>` rejects a missing or extra key).
 * English terms (compat bypass, ToolCall Compat, sandbox_permissions, ...)
 * are intentionally identical in both languages.
 */
import type { LocaleKey } from './zh.js'

export const en: Record<LocaleKey, string> = {
  cardRunning: 'Running…',
  cardDone: 'Done',
  cardFailed: 'Failed',
  expandInput: 'Expand input',
  collapseInput: 'Collapse input',
  expandOutput: 'Expand output',
  collapseOutput: 'Collapse output',
  bannerPrefix: '⚠ Tool call unresponsive for a long time: ',
  bannerRunning: ' (running {s}s)',
  skip: 'Skip',
  cardDesc: 'Third-party model ToolCall compatibility (schema cleanup) and unresponsive-call skip',
  enabledTitle: 'ToolCall compatibility mode',
  enabledDesc: 'Auto-clean invalid or redundant sandbox_permissions / justification in tool calls (all stripped in Full access); legitimate escalation requests are preserved and go through approval',
  escapesTitle: 'Render escape sequences when expanded',
  escapesDesc: 'Render escape sequences (\\n, \\" etc.) in arguments and output as characters when a tool-call card is expanded',
  thresholdTitle: 'Unresponsive notice threshold',
  thresholdDesc: 'Show the unresponsive notice after a tool call runs longer than this (1–600 s)',
  secondsUnit: 's',
  thresholdAria: 'Unresponsive notice threshold (seconds)',
  expandSettings: 'Expand settings',
  collapseSettings: 'Collapse settings',
}
