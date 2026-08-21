/**
 * Client half of @yukari316/dsh-toolcall-compat:
 *
 * 1. 「ToolCall Compat」config card in Settings → Plugins (settings.plugin.item,
 *    keyed by the `toolcall-compat` settings namespace) — reads and writes the
 *    durable preferences (`enabled`, `renderEscapes`, `stuckAfterMs`) through
 *    the settings-namespace scope contract (`ctx.settingsScope.bind`); the
 *    Host half enforces them on every model stream and dispatch.
 *
 * 2. Stuck-call skip: replaces the `conversation.chat.node` `tool-call`
 *    renderer with a self-drawn call tree. Each running call card gets a
 *    card-style banner ABOVE it (`⚠ 工具调用长时间未响应：<tool>（已运行 Xs）
 *    [跳过]`) once the Host reports it has been running past the stuck
 *    threshold, and the skip button asks the Host to race-complete that call
 *    with an LLM-facing "skipped because unresponsive" result.
 *
 *    WHY self-drawn: `conversation.chat.node` is a keyed slot (one winner) —
 *    inserting a banner above the shipped cards requires replacing the node
 *    renderer, and a replacement entry cannot delegate to the shipped atomic
 *    cards because `renderSlot` faces are entry-owned (`entry.children`), and
 *    `tool.call.toolview` is already declared by the shipped entry. The
 *    self-drawn card preserves the information (tool name, arguments, output)
 *    at the cost of the shipped per-tool views.
 *
 * No persistence logic lives here — the Host settings document is the single
 * fact source, and the Host owns the in-flight call table.
 */
import { Context } from '@deepseek-ai/cordis'
import type { SettingsScope, SettingsScopeSnapshot, ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsScopeBinder } from '@deepseek-ai/dsh-client-ui-settings/client'
import * as React from 'react'

export const name = 'dsh-toolcall-compat/client'

/** Required client services. */
export const inject = ['slots', 'settingsScope', 'remote']

/** Settings namespace name, shared with the host half. Must match /^[a-z][a-z0-9-]*$/. */
export const SETTINGS_NS = 'toolcall-compat'

/** A running call is offered for skipping once it exceeds this duration. */
export const STUCK_AFTER_MS = 15000

/** Poll interval for the stuck-call store. */
const POLL_MS = 3000

/** Locale dictionary namespace owned by this plugin. */
export const LOCALE_NS = 'toolcallCompat'

// Dictionaries live in ./locales/{zh,en}.ts; zh is the key-set source of
// truth and en is compile-checked against it.
import { zh, type LocaleKey } from './locales/zh.js'
import { en } from './locales/en.js'

// Pure display helpers live in ./format.ts (no React/DSH deps); re-exported
// for a stable public surface.
import { blockText, fmt, toolIcon, truncate, unescapeForDisplay } from './format.js'
export { blockText, fmt, toolIcon, truncate, unescapeForDisplay } from './format.js'

/** Resolved shape of the namespace section. */
export interface ToolcallSettings {
  enabled: boolean
  renderEscapes: boolean
  stuckAfterMs: number
}

/** One possibly-stuck call as reported by the Host. */
export interface StuckCallView {
  callId: string
  toolName: string
  runningMs: number
}

/** Structural type of the `toolcallControl` Remote namespace. */
interface ToolcallControlRemote {
  stuck(request: { sinceMs?: number; sessionId?: string }): Promise<{ calls: StuckCallView[] }>
  skip(request: { callId: string }): Promise<{ ok: boolean; error?: string; toolName?: string }>
  stripped(): Promise<{ callIds: string[] }>
}

/** Minimal props shape of the `conversation.chat.node` `tool-call` entry. */
export interface ToolCallNodeProps {
  node: { data: { root: ToolCallBlock } }
  selectedCallId?: string
  inspectCall?: (callId: string) => void
}

/** Styles for both surfaces; theme variables keep light/dark parity. */
const ROW_CSS = [  '.tcstrip-row{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}',
  '.tcstrip-row-text{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}',
  '.tcstrip-row-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
  '.tcstrip-row-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
  '.tcstrip-switch{position:relative;width:40px;height:22px;border-radius:11px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);cursor:pointer;padding:0;flex:none;transition:background .15s ease,border-color .15s ease}',
  '.tcstrip-switch:disabled{cursor:default;opacity:.55}',
  '.tcstrip-switch.tcstrip-on{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
  '.tcstrip-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s ease}',
  '.tcstrip-switch.tcstrip-on .tcstrip-knob{transform:translateX(18px)}',
  '.tcskip-callRow{border-radius:6px}',
  '.tcskip-subCalls{border-left:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:4px;margin:4px 0 2px 22px;padding-left:8px;display:flex}',
  '.tcskip-banner{display:flex;align-items:center;gap:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-state-warn-primary);border-radius:6px;padding:6px 8px;margin:0 0 6px;max-width:100%}',
  '.tcskip-banner-text{color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;flex:1;min-width:0}',
  '.tcskip-banner-btn{flex:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;border-radius:12px;padding:2px 10px;cursor:pointer}',
  '.tcskip-banner-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.tcskip-card{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;overflow:hidden}',
  '.tcskip-card-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2)}',
  '.tcskip-icon{flex:none;width:18px;text-align:center;font-size:14px;line-height:20px}',
  '.tcskip-card-title{font-size:14px;font-weight:400;color:var(--dsw-alias-label-primary);line-height:22px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}',
  '.tcskip-card-title.tcskip-cordis{color:var(--dsw-alias-state-business-primary);font-weight:500}',
  '.tcskip-card-state{flex:none;margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:18px}',
  '.tcskip-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary)}',
  '.tcskip-card-arg{padding:6px 10px;color:var(--dsw-alias-label-secondary);font-size:12px;font-family:var(--ds-font-family-code, monospace);white-space:pre-wrap;word-break:break-all;border-bottom:1px solid var(--dsw-alias-border-l2);max-height:120px;overflow:auto}',
  '.tcskip-card-out{padding:8px 10px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto}',
  '.tcskip-card-out.tcskip-error{color:var(--dsw-alias-state-error-primary)}',
  '.tcskip-card-arg-row,.tcskip-card-out-row{display:flex}',
  '.tcskip-card-arg-row{border-bottom:1px solid var(--dsw-alias-border-l2)}',
  '.tcskip-row-top{align-items:flex-start}',
  '.tcskip-row-center{align-items:center}',
  '.tcskip-card-arg,.tcskip-card-out{flex:1;min-width:0}',
  '.tcskip-chevron{flex:none;background:none;border:none;color:var(--dsw-alias-label-secondary);width:24px;height:24px;padding:0;display:flex;align-items:center;justify-content:center;cursor:pointer;border-radius:4px}',
  '.tcskip-chevron:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
  // Folded rows: exactly one line tall (line-height 18px + the row's own
  // padding), so text is never clipped.
  '.tcskip-card-arg.tcskip-folded{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-height:30px}',
  '.tcskip-card-out.tcskip-folded{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-height:34px}',
  // Plugin-config card, replicating the shipped PluginCard look (collapsible).
  '.tcpc-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}',
  '.tcpc-card:hover{border-color:var(--dsw-alias-label-dimmed)}',
  '.tcpc-card-open{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
  '.tcpc-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
  '.tcpc-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
  '.tcpc-head-text{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
  '.tcpc-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
  '.tcpc-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
  '.tcpc-chevron{color:var(--dsw-alias-label-tertiary);flex:none;display:flex;transition:transform .16s}',
  '.tcpc-chevron-open{transform:rotate(180deg)}',
  '.tcpc-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
  '.tcpc-field{border-bottom:none}',
  // Compat-bypass badge (yellow pill) and threshold input.
  '.tcskip-bypass{flex:none;border:1px solid var(--dsw-alias-state-warn-primary);background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, transparent);color:var(--dsw-alias-label-primary);font-size:11px;font-weight:500;line-height:16px;border-radius:999px;padding:1px 8px;white-space:nowrap}',
  '.tcstrip-input{width:76px;height:32px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:0 10px;flex:none}',
  '.tcstrip-input:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}',
  '.tcstrip-input-unit{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
].join('')

/**
 * A switch row styled like the General-section rows, for one boolean field of
 * the settings scope. Rendered inside the plugin config card, not in Settings
 * → General. The slot passes no owner props, so the row draws its own label,
 * description, and switch.
 * @param props - the bound scope, the target field, and the copy.
 * @returns the row element tree.
 */
export function SettingsSwitchRow(props: {
  scope: SettingsScope<ToolcallSettings>
  field: 'enabled' | 'renderEscapes'
  title: string
  desc: string
}): React.ReactElement {
  const { scope, field, title, desc } = props
  const [ready, setReady] = React.useState(false)
  // Bind the scope methods: useSyncExternalStore invokes them as bare
  // functions, where `this` would be lost.
  const subscribe = React.useCallback((callback: () => void) => scope.subscribe(callback), [scope])
  const getSnapshot = React.useCallback(() => scope.getSnapshot(), [scope])
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot)
  const enabled = snapshot.status === 'ready' && snapshot.value !== undefined ? snapshot.value[field] === true : true

  React.useEffect(() => {
    if (snapshot.status === 'ready' && snapshot.value !== undefined) setReady(true)
  }, [snapshot])

  const toggle = () => {
    const next = !enabled
    // The write is serialized and revision-fenced by the scope; on failure the
    // scope reloads Host state and the subscription re-syncs the row.
    scope.set(field, next).catch(() => {})
  }

  return React.createElement('div', { className: 'tcstrip-row' },
    React.createElement('div', { className: 'tcstrip-row-text' },
      React.createElement('div', { className: 'tcstrip-row-title' }, title),
      React.createElement('div', { className: 'tcstrip-row-desc' }, desc),
    ),
    React.createElement('button', {
      type: 'button',
      role: 'switch',
      'aria-checked': enabled,
      'aria-label': title,
      disabled: !ready,
      className: 'tcstrip-switch' + (enabled ? ' tcstrip-on' : ''),
      onClick: toggle,
    }, React.createElement('span', { className: 'tcstrip-knob' })),
  )
}

/**
 * Polyline chevron arrow in the app's icon style (WinUI-like folded line).
 * @param props - direction: `up` renders the collapsed-chevron (∧).
 * @returns the SVG element, colored via `currentColor`.
 */
export function Chevron(props: { up: boolean }): React.ReactElement {
  return React.createElement('svg', {
    width: 12,
    height: 12,
    viewBox: '0 0 24 24',
    fill: 'none',
    'aria-hidden': true,
  }, React.createElement('polyline', {
    // Flatter, softer chevron (≈30°): symmetric around the viewBox center
    // (y=12), wider x span (4–20) with a shallower y span (9–15).
    points: props.up ? '4 15, 12 9, 20 15' : '4 9, 12 15, 20 9',
    stroke: 'currentColor',
    strokeWidth: 3,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    fill: 'none',
  }))
}

/** Minimal locale translate face. */
type Translate = (key: LocaleKey) => string

/**
 * Self-drawn call card: tool icon + name (blue for `cordis_*`, mirroring the
 * shipped ToolRow), lifecycle state, arguments, and output text. Input and
 * output collapse INDEPENDENTLY to a single ellipsized line; each row's
 * right-hand polyline chevron (∨ expand / ∧ collapse) toggles it. When
 * `renderEscapes` is ON, expanded rows decode escape sequences into
 * characters. Replaces the shipped per-tool views (see the module doc).
 * @param props - tool name, block, preferences, and the translator.
 * @returns the card element tree.
 */
export function ToolCallCard(props: { toolName: string; block: ToolCallBlock; renderEscapes: boolean; bypassed: boolean; t: Translate }): React.ReactElement {
  const { toolName, block, renderEscapes, bypassed, t } = props
  const [argExpanded, setArgExpanded] = React.useState(false)
  const [outExpanded, setOutExpanded] = React.useState(false)
  const running = !('kind' in block)
  const args = running ? (block.argsRaw ?? '') : ((block.call && block.call.argsRaw) ?? '')
  const out = running ? null : blockText(block.content)
  const error = !running && block.isError === true
  const stop = (event: { stopPropagation?: () => void }) => {
    // Do not bubble into the call-row's inspect action.
    if (event !== undefined && typeof event.stopPropagation === 'function') event.stopPropagation()
  }
  const renderExpanded = (text: string, max: number) => (renderEscapes ? unescapeForDisplay(text, max) : truncate(text, max))
  const argText = args ? (argExpanded ? renderExpanded(args, 2000) : truncate(args, 160)) : ''
  const outText = out ? (outExpanded ? renderExpanded(out, 8000) : truncate(out, 200)) : ''
  const argRow = args
    ? React.createElement('div', { className: 'tcskip-card-arg-row' + (argExpanded ? ' tcskip-row-top' : ' tcskip-row-center') },
        React.createElement('div', { className: 'tcskip-card-arg' + (argExpanded ? '' : ' tcskip-folded') }, argText),
        React.createElement('button', {
          type: 'button',
          className: 'tcskip-chevron',
          'aria-label': argExpanded ? t('collapseInput') : t('expandInput'),
          'aria-expanded': argExpanded,
          onClick: (event: { stopPropagation?: () => void }) => {
            stop(event)
            setArgExpanded((value) => !value)
          },
        }, React.createElement(Chevron, { up: argExpanded })),
      )
    : null
  const outRow = out
    ? React.createElement('div', { className: 'tcskip-card-out-row' + (outExpanded ? ' tcskip-row-top' : ' tcskip-row-center') },
        React.createElement('div', { className: 'tcskip-card-out' + (error ? ' tcskip-error' : '') + (outExpanded ? '' : ' tcskip-folded') }, outText),
        React.createElement('button', {
          type: 'button',
          className: 'tcskip-chevron',
          'aria-label': outExpanded ? t('collapseOutput') : t('expandOutput'),
          'aria-expanded': outExpanded,
          onClick: (event: { stopPropagation?: () => void }) => {
            stop(event)
            setOutExpanded((value) => !value)
          },
        }, React.createElement(Chevron, { up: outExpanded })),
      )
    : null
  return React.createElement('div', { className: 'tcskip-card' },
    React.createElement('div', { className: 'tcskip-card-head' },
      React.createElement('span', { className: 'tcskip-icon' }, toolIcon(toolName)),
      bypassed ? React.createElement('span', { className: 'tcskip-bypass' }, 'compat bypass') : null,
      React.createElement('span', {
        className: 'tcskip-card-title' + (toolName.startsWith('cordis_') ? ' tcskip-cordis' : ''),
      }, toolName || '(unnamed)'),
      React.createElement('span', { className: 'tcskip-card-state' },
        running ? t('cardRunning') : (error ? t('cardFailed') : t('cardDone'))),
    ),
    argRow,
    outRow,
  )
}

/**
 * Enhanced tool-call tree: the shipped node structure (root + recursive
 * subCalls, `data-chat-anchor-key`/`data-chat-call-id` anchors, selection and
 * inspect wiring) with a stuck banner + skip button above each running call.
 * @param props - node currency plus the shared stuck-call store via props.
 * @returns the call tree.
 */
export function EnhancedToolCallTree(props: ToolCallNodeProps & { skipCall: (callId: string) => void; t?: Translate }): React.ReactElement {
  const { node, selectedCallId, inspectCall, skipCall } = props
  const t: Translate = props.t ?? ((key: keyof typeof zh) => zh[key])
  const stuck = React.useSyncExternalStore(stuckSubscribe, stuckGetSnapshot)
  const bypassed = React.useSyncExternalStore(bypassSubscribe, bypassGetSnapshot)
  const settings = React.useSyncExternalStore(settingsSubscribe, settingsGetSnapshot)
  const renderEscapes = settings.status === 'ready' && settings.value !== undefined
    ? settings.value.renderEscapes !== false
    : true
  const renderBranch = (block: ToolCallBlock): React.ReactElement => {
    const running = !('kind' in block)
    const callId = block.callId
    const toolName = running ? (block.name ?? '') : ((block.call && block.call.name) ?? '')
    const stuckInfo = running ? stuck.get(callId) : undefined
    const banner = stuckInfo
      ? React.createElement('div', { className: 'tcskip-banner' },
          React.createElement('span', { className: 'tcskip-banner-text' },
            fmt(t('bannerPrefix') + toolName + t('bannerRunning'), { s: Math.max(1, Math.round(stuckInfo.runningMs / 1000)) })),
          React.createElement('button', {
            type: 'button',
            className: 'tcskip-banner-btn',
            onClick: () => skipCall(callId),
          }, t('skip')),
        )
      : null
    const subCalls = block.subCalls && block.subCalls.length > 0
      ? React.createElement('div', { className: 'tcskip-subCalls', 'data-subcalls': true },
          block.subCalls.map((child) => renderBranch(child)),
        )
      : null
    return React.createElement('div', null,
      banner,
      React.createElement('div', {
        className: 'tcskip-callRow',
        'data-chat-anchor-key': `call:${callId}`,
        'data-chat-call-id': callId,
        'data-selected': selectedCallId === callId || undefined,
        onClick: typeof inspectCall === 'function' ? () => inspectCall(callId) : undefined,
      },
        React.createElement(ToolCallCard, { toolName, block, renderEscapes, bypassed: bypassed.has(callId), t }),
        subCalls,
      ),
    )
  }
  return renderBranch(node.data.root)
}

// --- shared stuck-call store (module state owned by the plugin fiber) ---

let stuckMap = new Map<string, StuckCallView>()
const stuckListeners = new Set<() => void>()
function stuckSubscribe(callback: () => void): () => void {
  stuckListeners.add(callback)
  return () => {
    stuckListeners.delete(callback)
  }
}
function stuckGetSnapshot(): Map<string, StuckCallView> {
  return stuckMap
}

// --- shared bypass set (call ids whose escalation args were stripped) ---

let bypassSet = new Set<string>()
const bypassListeners = new Set<() => void>()
function bypassSubscribe(callback: () => void): () => void {
  bypassListeners.add(callback)
  return () => {
    bypassListeners.delete(callback)
  }
}
function bypassGetSnapshot(): Set<string> {
  return bypassSet
}

// --- shared settings snapshot (bound scope owned by the plugin fiber) ---

let boundScope: SettingsScope<ToolcallSettings> | null = null
const emptySettingsSnapshot: SettingsScopeSnapshot<ToolcallSettings> = { status: 'loading', value: undefined, base: undefined, user: undefined, revision: undefined, writable: false, mode: 'host' }
function settingsSubscribe(callback: () => void): () => void {
  if (boundScope === null) return () => {}
  return boundScope.subscribe(callback)
}
function settingsGetSnapshot(): SettingsScopeSnapshot<ToolcallSettings> {
  return boundScope === null ? emptySettingsSnapshot : boundScope.getSnapshot()
}

/**
 * A row in the General row style, with a numeric input (seconds) for the
 * unresponsive threshold. Writes milliseconds into the settings scope on
 * blur/Enter.
 * @param props - the bound scope.
 * @returns the row element tree.
 */
export function StuckThresholdRow(props: { scope: SettingsScope<ToolcallSettings>; t: Translate }): React.ReactElement {
  const { scope, t } = props
  const subscribe = React.useCallback((callback: () => void) => scope.subscribe(callback), [scope])
  const getSnapshot = React.useCallback(() => scope.getSnapshot(), [scope])
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot)
  const ms = snapshot.status === 'ready' && typeof snapshot.value?.stuckAfterMs === 'number'
    ? snapshot.value.stuckAfterMs
    : STUCK_AFTER_MS
  const seconds = Math.max(1, Math.round(ms / 1000))
  const [text, setText] = React.useState(String(seconds))
  React.useEffect(() => {
    setText(String(seconds))
  }, [seconds])
  const commit = () => {
    const parsed = Number(text)
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 600) {
      scope.set('stuckAfterMs', Math.round(parsed * 1000)).catch(() => {})
    } else {
      setText(String(seconds))
    }
  }
  return React.createElement('div', { className: 'tcstrip-row tcstrip-row-bare' },
    React.createElement('div', { className: 'tcstrip-row-text' },
      React.createElement('div', { className: 'tcstrip-row-title' }, t('thresholdTitle')),
      React.createElement('div', { className: 'tcstrip-row-desc' }, t('thresholdDesc')),
    ),
    React.createElement('input', {
      type: 'number',
      min: 1,
      max: 600,
      step: 1,
      className: 'tcstrip-input',
      value: text,
      'aria-label': t('thresholdAria'),
      onChange: (event: { target: { value: string } }) => setText(event.target.value),
      onBlur: commit,
      onKeyDown: (event: { key: string }) => {
        if (event.key === 'Enter') commit()
      },
    }),
    React.createElement('span', { className: 'tcstrip-input-unit' }, t('secondsUnit')),
  )
}

/**
 * The plugin-configuration card shown in Settings → Plugins → 插件配置,
 * keyed by this plugin's settings namespace. Replicates the shipped
 * PluginCard look: a collapsible header (name + description + rotating
 * chevron) with the two preference switches in the expanded body.
 * @param props - the bound settings scope and the translator.
 * @returns the card element tree.
 */
export function PluginConfigCard(props: { scope: SettingsScope<ToolcallSettings>; t: Translate }): React.ReactElement {
  const { scope, t } = props
  const [open, setOpen] = React.useState(false)
  return React.createElement('li', { className: 'tcpc-card' + (open ? ' tcpc-card-open' : '') },
    React.createElement('button', {
      type: 'button',
      className: 'tcpc-header',
      'aria-expanded': open,
      'aria-label': `${open ? t('collapseSettings') : t('expandSettings')}: ToolCall Compat`,
      onClick: () => setOpen((value) => !value),
    },
      React.createElement('div', { className: 'tcpc-head-text' },
        React.createElement('div', { className: 'tcpc-name' }, 'ToolCall Compat'),
        React.createElement('div', { className: 'tcpc-desc' }, t('cardDesc')),
      ),
      React.createElement('span', { className: 'tcpc-chevron' + (open ? ' tcpc-chevron-open' : '') },
        React.createElement(Chevron, { up: false }),
      ),
    ),
    open
      ? React.createElement('div', { className: 'tcpc-body' },
          React.createElement('div', { className: 'tcpc-field' },
            React.createElement(SettingsSwitchRow, {
              scope,
              field: 'enabled',
              title: t('enabledTitle'),
              desc: t('enabledDesc'),
            }),
          ),
          React.createElement('div', { className: 'tcpc-field' },
            React.createElement(SettingsSwitchRow, {
              scope,
              field: 'renderEscapes',
              title: t('escapesTitle'),
              desc: t('escapesDesc'),
            }),
          ),
          React.createElement('div', { className: 'tcpc-field' },
            React.createElement(StuckThresholdRow, { scope, t }),
          ),
        )
      : null,
  )
}

/**
 * Client plugin body: bind the durable namespace scope, register the plugin
 * configuration card, start the stuck-call poller, and register the enhanced
 * tool-call tree.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context) {
  // Package stylesheet, owned by this fiber (removed when the plugin stops).
  if (typeof document !== 'undefined') {
    ctx.effect(() => {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@yukari316/dsh-toolcall-compat'
      tag.dataset.pluginCss = '@yukari316/dsh-toolcall-compat/client'
      tag.textContent = ROW_CSS
      document.head.appendChild(tag)
      return () => {
        tag.remove()
      }
    }, 'dsh-toolcall-compat: stylesheet')
  }

  // Locale dictionaries for the plugin's own copy.
  const locale = ctx.get('locale') as { register(ns: string, dict: Record<string, unknown>): () => void } | undefined
  if (locale !== undefined) {
    ctx.effect(() => locale.register(LOCALE_NS, { zh, en }), 'dsh-toolcall-compat: dictionaries')
  }

  // Settings: the plugin-configuration card (keyed by the settings namespace).
  const binder = ctx.get('settingsScope') as SettingsScopeBinder | undefined
  if (binder !== undefined) {
    const scope = binder.bind<ToolcallSettings>({ namespace: SETTINGS_NS })
    boundScope = scope
    ctx.slots.inject('settings.plugin.item', () => ctx.slots.register(
      { name: 'settings.plugin.item', key: SETTINGS_NS, scope, locale: LOCALE_NS },
      PluginConfigCard,
    ))
  }

  // Stuck-call support; degrade gracefully when the Host Remote is unavailable.
  const remote = ctx.get('remote') as { toolcallControl?: ToolcallControlRemote } | undefined
  const control = remote?.toolcallControl
  if (control === undefined) return

  // Shared poller: refresh the stuck map, the bypass set, and notify
  // subscribers. The unresponsive threshold comes from the settings scope.
  const poll = async () => {
    try {
      const snapshot = boundScope === null ? null : boundScope.getSnapshot()
      const sinceMs = snapshot !== null && snapshot.status === 'ready' && typeof snapshot.value?.stuckAfterMs === 'number'
        ? snapshot.value.stuckAfterMs
        : STUCK_AFTER_MS
      const [stuckResponse, strippedResponse] = await Promise.all([
        control.stuck({ sinceMs }),
        control.stripped(),
      ])
      const next = new Map<string, StuckCallView>()
      for (const call of stuckResponse.calls) next.set(call.callId, call)
      stuckMap = next
      bypassSet = new Set(strippedResponse.callIds)
    } catch {
      // Transient RPC failure: keep the last known state.
    }
    for (const listener of stuckListeners) listener()
    for (const listener of bypassListeners) listener()
  }
  poll()
  const pollTimer = window.setInterval(poll, POLL_MS)
  ctx.effect(() => () => {
    window.clearInterval(pollTimer)
    stuckListeners.clear()
  })

  const skipCall = (callId: string) => {
    control.skip({ callId }).catch(() => {})
  }

  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register(
    { name: 'conversation.chat.node', key: 'tool-call', locale: LOCALE_NS },
    (props: ToolCallNodeProps & { t?: Translate }) => React.createElement(EnhancedToolCallTree, { ...props, skipCall }),
  ))
}

// No `export default` here on purpose: DSH's client loader unwraps module
// exports via `exports.default ?? exports` and would then return the bare
// apply function, dropping the `inject` list. Shipped client bundles export
// named `apply`/`inject` only.
