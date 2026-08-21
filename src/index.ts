/**
 * Host half of @yukari316/dsh-toolcall-compat.
 *
 * Two capabilities:
 *
 * 1. Schema-fix: DSH validates the tool-call escalation pair
 *    (`sandbox_permissions` / `justification`) in `dsh-sandbox` — the
 *    justification must be a non-empty sentence and travel together with
 *    `sandbox_permissions`, and the requested mode must be strictly wider than
 *    the call's effective mode. Third-party models (GPT and other providers)
 *    frequently mis-parse the tool schemas and attach these two fields on
 *    every call, so every retry fails identically with
 *    `sandbox escalation to "..." is not strictly wider ...` or
 *    `invalid justification: expected a non-empty sentence`. The agent loop
 *    assembles each assistant message from the `llm/stream` chunk stream, and
 *    every `tool-call` block's complete arguments ride the closing
 *    `block-end` chunk — so wrapping that waterfall and applying the
 *    escalation verdict fixes dispatch, the durable chunk log, and replay in
 *    one place (tool arguments are deep-frozen at `createExecution`, so no
 *    dispatch-stage hook can rewrite them). The verdict is NOT unconditional:
 *    the plugin resolves the stream's effective sandbox mode and strips the
 *    pair only when it is malformed (unpaired keys, empty/non-string
 *    justification) or redundant (the target is not strictly wider — in Full
 *    access nothing is). A legitimate wider escalation request is preserved
 *    and runs the normal user-approval flow.
 *
 * 2. Stuck-call skip: a `tools/execute` around-dispatch wrapper tracks every
 *    in-flight call and races the real dispatch against a user-triggered skip
 *    signal. When the user asks to skip a call that appears stuck, the race
 *    settles with a failure-shaped result that tells the LLM the call was
 *    skipped because it was unresponsive, and the fused execution signal
 *    aborts so cooperative tools terminate. The browser discovers
 *    possibly-stuck calls and triggers skips through the `toolcallControl`
 *    Remote service.
 *
 * The schema-fix switch is a durable settings namespace
 * (`toolcall-compat.enabled`, default ON) surfaced in the browser Settings
 * panel by `./client.ts`.
 */
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { SessionStore } from '@deepseek-ai/dsh-session'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import type { ToolDispatchExecution, ToolExecutionFailure, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
// Pure decision logic lives in ./compat.ts (no DSH runtime deps); re-exported
// here so the package's public surface stays stable.
import {
  WIDER_MODES,
  classifyEscalation,
  rewriteToolCallChunks,
  stripEscalationArgs,
  stuckSkipResult,
  type EscalationVerdict,
  type SandboxMode,
} from './compat.js'
export {
  WIDER_MODES,
  classifyEscalation,
  rewriteToolCallChunks,
  stripEscalationArgs,
  stuckSkipResult,
  type EscalationVerdict,
  type SandboxMode,
} from './compat.js'

export const name = 'dsh-toolcall-compat'

/** Settings namespace name, shared with the client half. Must match /^[a-z][a-z0-9-]*$/. */
export const SETTINGS_NS = 'toolcall-compat'

/** Branded Host-side settings namespace key. */
export const NS = settingsNamespace(SETTINGS_NS)

/** A running call is offered for skipping once it exceeds this duration. */
export const STUCK_AFTER_MS = 15000

/** Durable preference schema: the compatibility switch, default ON. */
export const SettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** When ON, expanded tool-call cards render escape sequences as characters. */
  renderEscapes: z.boolean().default(true),
  /** Running duration (ms) after which a call is offered for skipping. */
  stuckAfterMs: z.number().default(STUCK_AFTER_MS),
})

/** One possibly-stuck call as reported to the browser. */
export interface StuckCallView {
  callId: string
  toolName: string
  runningMs: number
}

/** Outcome of a user skip request. */
export interface SkipOutcome {
  ok: boolean
  error?: string
  toolName?: string
}

/** One tracked in-flight call. */
interface InflightCall {
  callId: string
  toolName: string
  sessionId?: string
  startedAt: number
  controller: AbortController
  skipped: Promise<void>
  resolveSkip: () => void
}

/**
 * Remote service the browser uses to discover possibly-stuck calls, to learn
 * which calls were bypassed, and to skip them. Registered as
 * `ctx.toolcallControl` and reachable from the client as
 * `ctx.remote.toolcallControl`.
 */
export class ToolcallControlService extends TypertRemoteService {
  /** In-flight calls, keyed by call id. */
  readonly inflight = new Map<string, InflightCall>()

  /** Call ids whose escalation args were stripped by the compat bypass. */
  readonly stripped = new Map<string, number>()

  constructor(ctx: Context) {
    super(ctx, 'toolcallControl')
  }

  /** Remember one bypassed call (call id → timestamp). */
  markStripped(callId: string): void {
    this.stripped.set(callId, Date.now())
  }

  /**
   * List calls that have been running for at least `sinceMs`.
   * @param request - optional duration floor and session filter.
   * @returns running calls, longest first.
   */
  @Remote('stuck')
  async stuck(request: { sinceMs?: number; sessionId?: string } = {}): Promise<{ calls: StuckCallView[] }> {
    const sinceMs = request.sinceMs ?? STUCK_AFTER_MS
    const now = Date.now()
    const calls: StuckCallView[] = []
    for (const entry of this.inflight.values()) {
      if (request.sessionId !== undefined && entry.sessionId !== request.sessionId) continue
      const runningMs = now - entry.startedAt
      if (runningMs >= sinceMs) calls.push({ callId: entry.callId, toolName: entry.toolName, runningMs })
    }
    calls.sort((left, right) => right.runningMs - left.runningMs)
    return { calls }
  }

  /**
   * List calls whose escalation args were stripped by the compat bypass.
   * Entries older than 5 minutes are dropped.
   * @returns the bypassed call ids.
   */
  @Remote('stripped')
  async strippedCalls(): Promise<{ callIds: string[] }> {
    const now = Date.now()
    for (const [callId, at] of this.stripped) {
      if (now - at > 5 * 60 * 1000) this.stripped.delete(callId)
    }
    return { callIds: [...this.stripped.keys()] }
  }

  /**
   * Skip one in-flight call: abort its fused signal (cooperative tools
   * terminate) and settle the `tools/execute` race with the skip result.
   * @param request - the call id shown on the stuck-call row.
   * @returns whether the call was still in flight and got skipped.
   */
  @Remote('skip')
  async skip(request: { callId: string }): Promise<SkipOutcome> {
    const entry = this.inflight.get(request.callId)
    if (entry === undefined) return { ok: false, error: 'no such in-flight tool call' }
    entry.controller.abort()
    entry.resolveSkip()
    return { ok: true, toolName: entry.toolName }
  }
}

/**
 * Resolve the effective sandbox mode for one model stream: the session named
 * by `GenerateOptions.sessionId` (its logged override). Returns `undefined`
 * when the mode cannot be confirmed (no policy service, no session, or a
 * resolution failure) — the caller then preserves legitimate escalation
 * pairs instead of guessing (see `classifyEscalation` in ./compat.ts).
 * This is the thin environment-adapter layer around the pure verdict logic.
 * @param ctx - host context.
 * @param options - the stream request carrying the session identity.
 * @returns the confirmed mode, or `undefined` when unresolvable.
 */
export function resolveEffectiveMode(ctx: Context, options: GenerateOptions): SandboxMode | undefined {
  const policy = ctx.get('sandboxPolicy') as SandboxPolicyService | undefined
  if (policy === undefined) return undefined
  const sessionId = options.sessionId
  if (sessionId === undefined) return undefined
  try {
    const sessions = ctx.get('sessions') as SessionStore | undefined
    const session = sessions?.get(sessionId)
    if (session === undefined) return undefined
    return policy.resolve({ session }).mode
  } catch {
    return undefined
  }
}

/** Create and register the in-flight entry for one dispatch. */
function trackInflight(control: ToolcallControlService, exec: ToolDispatchExecution): InflightCall {
  let resolveSkip!: () => void
  const skipped = new Promise<void>((resolve) => {
    resolveSkip = resolve
  })
  const entry: InflightCall = {
    callId: exec.callId,
    toolName: exec.name,
    sessionId: exec.agent?.id,
    startedAt: Date.now(),
    controller: new AbortController(),
    skipped,
    resolveSkip,
  }
  control.inflight.set(exec.callId, entry)
  return entry
}

/**
 * The around-dispatch wrapper body: track the call, fuse a user-controllable
 * abort signal into `exec.signal`, and race the real dispatch against the
 * skip signal. Exported for tests.
 * @param control - the in-flight registry.
 * @param exec - the mutable dispatch execution (signal may be replaced for
 *   the delegated lifetime and is restored afterwards).
 * @param next - the innermost dispatch (tool body).
 * @returns the dispatch result, or the skip result when the user skips first.
 */
export async function skipAwareDispatch(
  control: ToolcallControlService,
  exec: ToolDispatchExecution,
  next: () => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  const entry = trackInflight(control, exec)
  const upstream = exec.signal
  // `exec.signal` is required by contract, but a wrapper must never throw
  // before the tool body (a thrown wrapper fails EVERY dispatch). Fall back
  // to a fresh signal when it is absent.
  const upstreamSignal = upstream ?? new AbortController().signal
  exec.signal = AbortSignal.any([upstreamSignal, entry.controller.signal])
  try {
    const settled = await Promise.race([
      next().then((result) => ({ kind: 'result' as const, result })),
      entry.skipped.then(() => ({ kind: 'skip' as const })),
    ])
    if (settled.kind === 'skip') {
      // The underlying promise settles later (or never); the registry has
      // already observed it, so its outcome is discarded.
      return stuckSkipResult(exec.name, Date.now() - entry.startedAt)
    }
    return settled.result
  } finally {
    if (control.inflight.get(exec.callId) === entry) control.inflight.delete(exec.callId)
    exec.signal = upstream
  }
}

/**
 * Host plugin body: register the durable preference, provide the stuck-call
 * control service, wrap every model stream (schema fix), and wrap every tool
 * dispatch (stuck-call skip).
 *
 * `llm/stream` and `tools/execute` dispatch on the shared event bus without a
 * scope filter, so these listeners receive every agent's model calls and tool
 * dispatches. Everything here is official hook surface — no fork of DSH.
 */
export function apply(ctx: Context) {
  // Durable compatibility switch.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(NS, SettingsSchema)
  })

  // Stuck-call control Remote (browser reaches it as ctx.remote.toolcallControl).
  const control = new ToolcallControlService(ctx)

  // 1. Schema fix: judge each tool-call block's escalation pair against the
  //    stream's effective sandbox mode — strip malformed or redundant pairs,
  //    keep legitimate wider escalations (they run the normal approval flow).
  //    The listener must NEVER throw: a thrown waterfall listener breaks the
  //    model stream (the UI would hang on "deep diving" forever). Any error
  //    falls back to the untouched downstream stream.
  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    try {
      const settings = ctx.get('settings')
      const section = settings?.get(NS) as { enabled?: boolean } | undefined
      const enabled = section?.enabled ?? true
      if (!enabled) return next()
      return rewriteToolCallChunks(next(), resolveEffectiveMode(ctx, options), (callId) => control.markStripped(callId))
    } catch (error) {
      ctx.logger.warn(`dsh-toolcall-compat: llm/stream wrapper failed, passing stream through: ${String(error)}`)
      return next()
    }
  })

  // 2. Stuck-call skip: track every in-flight call and race dispatch against
  //    the user's skip signal.
  ctx.on('tools/execute', (exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>) => {
    return skipAwareDispatch(control, exec, next)
  })
}

export default apply
