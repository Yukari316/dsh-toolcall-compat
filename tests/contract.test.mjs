/**
 * Contract tests for the pure modules (lib/compat.js, lib/format.js).
 *
 * Prove, at the boundary, that:
 * - `rewriteToolCallChunks` passes non-stripped chunks through byte-for-byte
 *   (the `next()` passthrough contract) and preserves every other field of a
 *   stripped tool-call block (only `arguments` is replaced);
 * - the escalation verdict / strip functions handle every edge input;
 * - the skip result keeps the failure shape required by normalizeDispatchResult;
 * - the display formatters behave (escape rendering, paths untouched).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyEscalation,
  rewriteToolCallChunks,
  stripEscalationArgs,
  stuckSkipResult,
} from '../lib/compat.js'
import { blockText, fmt, toolIcon, truncate, unescapeForDisplay } from '../lib/format.js'

const pair = (justification, target) => ({ command: 'dir', sandbox_permissions: target, justification })

async function collect(source, mode, onStripped) {
  const out = []
  for await (const chunk of rewriteToolCallChunks(source, mode, onStripped)) out.push(chunk)
  return out
}

test('rewriteToolCallChunks: non-stripped chunks pass through byte-for-byte', async () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: 'call-a', name: 'pwsh', argumentsDelta: '{"command":' },
    { type: 'tool-call-delta', index: 0, id: 'call-a', argumentsDelta: '"dir"}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-a', name: 'pwsh', arguments: JSON.stringify({ command: 'dir' }) } },
    { type: 'usage', usage: { inputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const out = await collect(chunks, 'read-only')
  assert.deepEqual(out, chunks, 'every chunk must be identical (next() passthrough)')
})

test('rewriteToolCallChunks: stripped block keeps id/name/index, only arguments changes', async () => {
  const strippedIds = []
  const chunk = {
    type: 'block-end',
    index: 7,
    block: {
      type: 'tool-call',
      id: 'call-b',
      name: 'pwsh',
      arguments: JSON.stringify(pair('', 'danger-full-access')),
      extraField: 'must-survive',
    },
  }
  const out = await collect([chunk], 'danger-full-access', (id) => strippedIds.push(id))
  assert.equal(out.length, 1)
  const end = out[0]
  assert.equal(end.type, 'block-end')
  assert.equal(end.index, 7, 'index preserved')
  assert.equal(end.block.id, 'call-b', 'call id preserved')
  assert.equal(end.block.name, 'pwsh', 'tool name preserved')
  assert.equal(end.block.extraField, 'must-survive', 'unknown fields preserved')
  assert.equal(end.block.arguments, '{"command":"dir"}', 'escalation pair stripped')
  assert.deepEqual(strippedIds, ['call-b'], 'onStripped fired exactly once with the call id')
})

test('rewriteToolCallChunks: legitimate escalation is preserved (keep)', async () => {
  const chunk = {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'call-c', name: 'bash', arguments: JSON.stringify(pair('I need it', 'workspace-write')) },
  }
  const out = await collect([chunk], 'read-only')
  assert.deepEqual(out, [chunk], 'well-formed wider request passes through untouched')
})

test('rewriteToolCallChunks: non-tool-call chunks untouched even with bad args', async () => {
  const chunks = [
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'hello' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'hello' } },
  ]
  const out = await collect(chunks, 'danger-full-access')
  assert.deepEqual(out, chunks)
})

test('classifyEscalation verdict matrix', () => {
  assert.equal(classifyEscalation({ command: 'x' }, 'read-only'), 'absent')
  assert.equal(classifyEscalation(pair('', 'danger-full-access'), 'danger-full-access'), 'strip')
  assert.equal(classifyEscalation(pair('I need it', 'danger-full-access'), 'danger-full-access'), 'strip')
  assert.equal(classifyEscalation(pair('I need it', 'workspace-write'), 'read-only'), 'keep')
  assert.equal(classifyEscalation(pair('I need it', 'workspace-write'), 'workspace-write'), 'strip')
  // Unknown mode: legitimate forms are preserved (tool layer decides), only
  // clearly invalid pairs are stripped.
  assert.equal(classifyEscalation(pair('I need it', 'danger-full-access'), undefined), 'keep')
  assert.equal(classifyEscalation(pair('I need it', 'workspace-write'), undefined), 'keep')
  assert.equal(classifyEscalation(pair('', 'danger-full-access'), undefined), 'strip')
  assert.equal(classifyEscalation(pair('I need it', 'read-only'), undefined), 'strip')
  assert.equal(classifyEscalation({ command: 'x', justification: 'why' }, 'read-only'), 'strip')
  assert.equal(classifyEscalation({ command: 'x', sandbox_permissions: 'workspace-write' }, 'read-only'), 'strip')
  assert.equal(classifyEscalation(pair('I need it', 'read-only'), 'read-only'), 'strip')
})

test('stripEscalationArgs edge inputs', () => {
  assert.equal(stripEscalationArgs('{not json', 'read-only'), null)
  assert.equal(stripEscalationArgs('"just a string"', 'read-only'), null)
  assert.equal(stripEscalationArgs('[1,2]', 'read-only'), null)
  assert.equal(stripEscalationArgs('null', 'read-only'), null)
  assert.equal(stripEscalationArgs(JSON.stringify({ command: 'x' }), 'read-only'), null)
  assert.equal(stripEscalationArgs(JSON.stringify(pair('', 'danger-full-access')), 'danger-full-access'), '{"command":"dir"}')
  assert.equal(stripEscalationArgs(JSON.stringify(pair('I need it', 'workspace-write')), 'read-only'), null)
})

test('stuckSkipResult failure shape required by normalizeDispatchResult', () => {
  const result = stuckSkipResult('bash', 123456)
  assert.equal(result.isError, true, 'must be a failure result (value validation is skipped)')
  assert.equal(result.error.info.code, 'TOOL_SKIPPED')
  assert.equal(result.error.info.name, 'ToolSkippedError')
  assert.match(result.content[0].text, /was unresponsive \(running 123s\)/)
  assert.match(result.content[0].text, /do not retry this call/)
})

test('unescapeForDisplay: JSON string literal, pretty-print, plain text, paths untouched', () => {
  assert.equal(unescapeForDisplay('"a\\nb"', 100), 'a\nb')
  assert.equal(unescapeForDisplay('{"command":"dir","n":1}', 200), '{\n  "command": "dir",\n  "n": 1\n}')
  assert.equal(unescapeForDisplay('line1\\nline2', 100), 'line1\nline2')
  assert.equal(unescapeForDisplay('path C:\\Users\\x stays', 100), 'path C:\\Users\\x stays')
  assert.equal(unescapeForDisplay('', 10), '')
})

test('truncate / fmt / toolIcon / blockText', () => {
  assert.equal(truncate('abcdef', 4), 'abcd…')
  assert.equal(truncate('abc', 10), 'abc')
  assert.equal(fmt('run {s}s', { s: 12 }), 'run 12s')
  assert.equal(fmt('no params', {}), 'no params')
  assert.equal(toolIcon('bash'), '💻')
  assert.equal(toolIcon('cordis_run'), '✨')
  assert.equal(toolIcon('unknown_tool'), '⚙️')
  assert.equal(blockText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'other' }]), 'a\nb\n')
  assert.equal(blockText(undefined), '')
})
