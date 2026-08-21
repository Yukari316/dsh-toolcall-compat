/**
 * Pure compatibility logic — no DSH runtime dependencies (type-only imports
 * only). Everything here is a deterministic function of its inputs:
 * escalation classification, argument stripping, the LLM-facing skip result,
 * and the stream rewrite. The cordis glue lives in `./index.ts`.
 */
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionFailure } from '@deepseek-ai/dsh-tools'

/** The sandbox mode ladder, mirroring `dsh-sandbox`'s WIDER_MODES table. */
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

/** What to do with the escalation pair found in one tool-call argument object. */
export type EscalationVerdict = 'absent' | 'strip' | 'keep'

/**
 * Strictly-wider ladder: the modes a call whose effective mode is the key may
 * escalate TO. `danger-full-access` has no entry — nothing is strictly wider,
 * so any escalation request made from Full access is redundant and must be
 * stripped.
 */
export const WIDER_MODES: Record<SandboxMode, SandboxMode[]> = {
  'read-only': ['workspace-write', 'danger-full-access'],
  'workspace-write': ['danger-full-access'],
  'danger-full-access': [],
}

/**
 * Judge whether a tool-call argument object's escalation pair is a LEGITIMATE
 * escalation request — the only case it must be preserved.
 *
 * A pair is legitimate iff both keys are present, the justification is a
 * non-empty string, and `sandbox_permissions` names a valid escalation target
 * (`workspace-write` / `danger-full-access`) strictly wider than the call's
 * effective mode. Everything else is malformed or redundant and gets
 * stripped. When the effective mode is UNKNOWN the pair is preserved in its
 * legitimate form (the enforcing tool layer resolves the real per-call mode
 * and runs the approval flow); only clearly invalid pairs are stripped then —
 * this prevents a mis-resolved mode from silently swallowing a legitimate
 * escalation request.
 */
export function classifyEscalation(args: Record<string, unknown>, effectiveMode: SandboxMode | undefined): EscalationVerdict {
  const has = Object.prototype.hasOwnProperty
  const hasTarget = has.call(args, 'sandbox_permissions')
  const hasJustification = has.call(args, 'justification')
  if (!hasTarget && !hasJustification) return 'absent'
  if (!hasTarget || !hasJustification) return 'strip'
  const justification = args.justification
  if (typeof justification !== 'string' || justification.trim().length === 0) return 'strip'
  const target = args.sandbox_permissions
  if (typeof target !== 'string') return 'strip'
  // Only the closed escalation-target vocabulary is a valid request.
  if (target !== 'workspace-write' && target !== 'danger-full-access') return 'strip'
  // Unknown effective mode: keep the legitimate form and let the tool layer
  // (which resolves the real per-call mode) decide.
  if (effectiveMode === undefined) return 'keep'
  if (!(WIDER_MODES[effectiveMode] ?? []).includes(target)) return 'strip'
  return 'keep'
}

/**
 * Parse a tool-call arguments JSON string and apply the escalation verdict:
 * legitimate escalation requests pass through untouched, everything else is
 * returned without the escalation pair.
 * @returns the cleaned JSON string, or `null` when the block should stay
 *   untouched (not JSON, not an object, absent pair, or legitimate request).
 */
export function stripEscalationArgs(raw: unknown, effectiveMode: SandboxMode | undefined): string | null {
  if (typeof raw !== 'string') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (classifyEscalation(record, effectiveMode) !== 'strip') return null
  const cleaned: Record<string, unknown> = { ...record }
  delete cleaned.sandbox_permissions
  delete cleaned.justification
  return JSON.stringify(cleaned)
}

/**
 * Wrap a chunk stream, rewriting `tool-call` blocks on their closing
 * `block-end` chunk according to the escalation verdict. Non-tool-call chunks
 * and untouched blocks pass through byte-for-byte; stripped blocks keep every
 * other field (id, name, index, ...) — only `arguments` is replaced.
 * @param source - the downstream stream (the `next()` result).
 * @param effectiveMode - the mode the assembled calls will execute under.
 * @param onStripped - called with each call id whose escalation pair was
 *   stripped (used for the compat-bypass badge).
 */
export async function* rewriteToolCallChunks(
  source: AsyncIterable<StreamChunk>,
  effectiveMode: SandboxMode | undefined,
  onStripped?: (callId: string) => void,
): AsyncIterable<StreamChunk> {
  for await (const chunk of source) {
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'block-end'
        && chunk.block !== null && typeof chunk.block === 'object' && chunk.block.type === 'tool-call') {
      const cleaned = stripEscalationArgs(chunk.block.arguments, effectiveMode)
      if (cleaned !== null) {
        if (typeof onStripped === 'function' && typeof chunk.block.id === 'string') onStripped(chunk.block.id)
        yield { ...chunk, block: { ...chunk.block, arguments: cleaned } }
        continue
      }
    }
    yield chunk
  }
}

/**
 * The model-facing result substituted when a stuck call is skipped.
 *
 * This MUST be a failure result (`isError: true` + `error`): the registry's
 * `normalizeDispatchResult` re-validates every non-canonical SUCCESS result's
 * `value` against the tool's own output schema, which a generic skip value
 * can never satisfy. Error results skip that validation. The content text
 * explicitly tells the model not to retry the call, and `error.info` carries
 * a stable code for retry/replay routing.
 */
export function stuckSkipResult(toolName: string, runningMs: number): ToolExecutionFailure {
  const seconds = Math.max(1, Math.round(runningMs / 1000))
  const message = `tool call skipped by user: ${toolName} was unresponsive (running ${seconds}s)`
  return {
    content: [{
      type: 'text',
      text: `[tool call skipped: ${toolName} was unresponsive (running ${seconds}s) and was skipped by the user — do not retry this call; continue the conversation]`,
    }],
    isError: true,
    error: {
      message,
      info: { name: 'ToolSkippedError', code: 'TOOL_SKIPPED' },
    },
  }
}
