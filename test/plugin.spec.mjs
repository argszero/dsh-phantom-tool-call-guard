/**
 * The plugin at the seam: a real `llm/stream` waterfall, the real assembler, the
 * real write boundary.
 *
 * Each arm pairs a control with the repaired run, because the claim is not "the
 * stream looks different" but "the call the harness would have refused is the
 * call it now accepts". `plugin: false` is that control: the same chunks, the
 * same dispatch, the same assembler — and the same refusal, reproduced.
 *
 * @module test/plugin.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { phantomId } from '../lib/stream.js'
import { admit, assemble, collect, logText, service, streamOf, toolCall, toolResultRow, world } from './harness.mjs'

/**
 * The phantom of #9215, in the shape `llm-pi-ai` emits it: a block-start, deltas
 * that all carry `id: ''` (the adapter writes `known?.id ?? ''`), and a closing
 * block whose id and name came back empty from the provider.
 */
const PHANTOM = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'Done.' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } },
  { type: 'block-start', index: 1, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 1, id: '', argumentsDelta: '{}' },
  { type: 'block-end', index: 1, block: { type: 'tool-call', id: '', name: '', arguments: '{}' } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

/** A tool call the provider identified properly — the ordinary case. */
const ORDINARY = [
  { type: 'block-start', index: 0, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 0, id: 'call-abc', name: 'read', argumentsDelta: '{}' },
  { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-abc', name: 'read', arguments: '{}' } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

/** A phantom whose closing block omits the id entirely (what a cast of `undefined` produces). */
const PHANTOM_ABSENT = [
  { type: 'block-start', index: 1, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 1, id: '', name: '', argumentsDelta: '{}' },
  { type: 'block-end', index: 1, block: { type: 'tool-call', id: undefined, name: '', arguments: '{}' } },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

/** A phantom no chunk ever gives an id at all — covered by the assembler's own fallback. */
const NO_ID_AT_ALL = [
  { type: 'block-start', index: 1, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 1, name: 'read', argumentsDelta: '{}' },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

/** What the harness emitted, what it assembles to, and whether its result is admitted. */
async function run(runWorld, chunks) {
  const emitted = await collect(runWorld.stream(chunks))
  const block = toolCall(assemble(emitted))
  return { emitted, block, row: admit(toolResultRow(block.id)) }
}

describe('the report, reproduced without the plugin', () => {
  it('assembles an empty id and has its tool/result refused by the write boundary', async () => {
    const control = await world({ plugin: false })
    const { block, row } = await run(control, PHANTOM)
    assert.equal(block.id, '')
    assert.equal(block.name, '')
    assert.equal(row.admitted, false)
    assert.match(row.reason, /requires toolCallId matching its tool source/)
    await control.dispose()
  })

  it('refuses the absent-id shape for the same reason', async () => {
    const control = await world({ plugin: false })
    const { block, row } = await run(control, PHANTOM_ABSENT)
    assert.equal(block.id, undefined)
    assert.equal(row.admitted, false)
    assert.match(row.reason, /requires toolCallId matching its tool source/)
    await control.dispose()
  })

  it('admits the row once an id is present — the boundary is about identity alone', async () => {
    const control = await world({ plugin: false })
    const { block, row } = await run(control, ORDINARY)
    assert.equal(block.id, 'call-abc')
    assert.deepEqual(row, { admitted: true })
    await control.dispose()
  })
})

describe('the plugin at the seam', () => {
  it('turns the refused call into one the write boundary accepts', async () => {
    const control = await world({ plugin: false })
    const unrepaired = await run(control, PHANTOM)
    const harness = await world()
    const repaired = await run(harness, PHANTOM)
    assert.equal(repaired.block.id, phantomId(1))
    assert.equal(repaired.block.name, '')
    // The same stream, the same number of chunks, the same order: identity is
    // the only thing this plugin touches.
    assert.deepEqual(repaired.emitted.map(chunk => chunk.type), unrepaired.emitted.map(chunk => chunk.type))
    assert.deepEqual(unrepaired.row.admitted, false)
    assert.deepEqual(repaired.row, { admitted: true })
    await control.dispose()
    await harness.dispose()
  })

  it('leaves an ordinary tool call exactly as it arrived', async () => {
    const harness = await world()
    const { emitted, block, row } = await run(harness, ORDINARY)
    assert.deepEqual(emitted, ORDINARY)
    assert.equal(block.id, 'call-abc')
    assert.deepEqual(row, { admitted: true })
    assert.equal(service(harness).snapshot().counters.verdicts.keep, 1)
    await harness.dispose()
  })

  it('repairs the absent-id shape as well', async () => {
    const harness = await world()
    const { block, row } = await run(harness, PHANTOM_ABSENT)
    assert.equal(block.id, phantomId(1))
    assert.deepEqual(row, { admitted: true })
    await harness.dispose()
  })

  it('leaves an id that was never stated to the assembler, whose fallback covers it', async () => {
    const harness = await world()
    const { emitted, block, row } = await run(harness, NO_ID_AT_ALL)
    assert.deepEqual(emitted, NO_ID_AT_ALL)
    // `BlockAssembler` writes `call-<index>` here, and that is a usable identity.
    assert.equal(block.id, 'call-1')
    assert.deepEqual(row, { admitted: true })
    const snapshot = service(harness).snapshot()
    assert.equal(snapshot.counters.reasons['id-never-arrived'], 1)
    assert.equal(snapshot.counters.verdicts.answer, 0)
    await harness.dispose()
  })

  it('records the decision with the route it belonged to', async () => {
    const harness = await world()
    await run(harness, PHANTOM)
    const snapshot = service(harness).snapshot()
    assert.equal(snapshot.counters.streams, 1)
    assert.equal(snapshot.counters.errors, 0)
    assert.deepEqual(snapshot.counters.verdicts, { keep: 0, answer: 1, suppress: 0 })
    assert.equal(snapshot.counters.reasons['empty-id'], 1)
    assert.deepEqual(snapshot.recent, [{
      provider: 'target',
      model: 'model-1',
      sessionId: undefined,
      index: 1,
      verdict: 'answer',
      reason: 'empty-id',
      written: phantomId(1),
      // The stream declared no name: the deltas omitted it and the closing block
      // stated it empty, and an empty name is not a name.
      name: undefined,
    }])
    await harness.dispose()
  })

  it('does not record an ordinary tool call in the history', async () => {
    const harness = await world()
    await run(harness, ORDINARY)
    assert.deepEqual(service(harness).snapshot().recent, [])
    assert.equal(service(harness).snapshot().counters.verdicts.keep, 1)
    await harness.dispose()
  })

  it('names the session in the log line when the request carries one', async () => {
    const harness = await world()
    await collect(harness.stream(PHANTOM, { sessionId: 'sess-7' }))
    assert.equal(service(harness).snapshot().recent[0].sessionId, 'sess-7')
    assert.match(logText(harness.logged), /closed without an id; wrote "call-phantom-1"/)
    await harness.dispose()
  })
})

describe('observe measures without acting', () => {
  it('emits the stream the unrepaired control emitted, and counts the same decision', async () => {
    const control = await world({ plugin: false })
    const unrepaired = await run(control, PHANTOM)
    const harness = await world({ config: { mode: 'observe' } })
    const observed = await run(harness, PHANTOM)
    assert.deepEqual(observed.emitted, unrepaired.emitted)
    assert.deepEqual(observed.row, unrepaired.row)
    assert.equal(observed.row.admitted, false)
    const snapshot = service(harness).snapshot()
    assert.equal(snapshot.mode, 'observe')
    assert.deepEqual(snapshot.counters.verdicts, { keep: 0, answer: 1, suppress: 0 })
    // The finding still carries the id a repairing mount would have written.
    assert.equal(snapshot.recent[0].written, phantomId(1))
    assert.match(logText(harness.logged), /would write "call-phantom-1"/)
    assert.doesNotMatch(logText(harness.logged), /; wrote "/)
    await control.dispose()
    await harness.dispose()
  })
})

describe('suppress removes the call instead of naming it', () => {
  it('leaves no tool-call block for the assembler to poison itself with', async () => {
    const harness = await world({ config: { mode: 'suppress' } })
    const emitted = await collect(harness.stream(PHANTOM))
    assert.deepEqual(emitted.filter(chunk => chunk.type === 'tool-call-delta' || chunk.type === 'block-end'), [
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } },
    ])
    const blocks = assemble(emitted)
    assert.deepEqual(blocks, [{ type: 'text', text: 'Done.' }])
    const snapshot = service(harness).snapshot()
    assert.deepEqual(snapshot.counters.verdicts, { keep: 0, answer: 0, suppress: 1 })
    assert.match(logText(harness.logged), /dropped the block/)
    await harness.dispose()
  })
})

describe('off installs no listener', () => {
  it('emits the unrepaired stream and still provides the service', async () => {
    const control = await world({ plugin: false })
    const unrepaired = await run(control, PHANTOM)
    const harness = await world({ config: { mode: 'off' } })
    const emitted = await collect(harness.stream(PHANTOM))
    assert.deepEqual(emitted, unrepaired.emitted)
    const snapshot = service(harness).snapshot()
    assert.equal(snapshot.mode, 'off')
    assert.equal(snapshot.counters.streams, 0)
    await control.dispose()
    await harness.dispose()
  })
})

describe('the listener position', () => {
  /** A block that a provider would never emit, used to place a stream in the chain. */
  const INJECTED = [
    { type: 'block-start', index: 9, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 9, id: '', argumentsDelta: '{}' },
    { type: 'block-end', index: 9, block: { type: 'tool-call', id: '', name: '', arguments: '{}' } },
  ]

  it('covers a block emitted by a listener mounted inside it', async () => {
    const harness = await world()
    // Default placement is innermost, so this listener sits *below* the guard and
    // its chunks pass through it — which is what makes the guard's position
    // load-bearing rather than incidental.
    harness.ctx.on('llm/stream', async function* (_options, next) {
      yield* next()
      yield* streamOf(INJECTED)
    })
    const blocks = assemble(await collect(harness.stream(ORDINARY)))
    assert.equal(blocks.filter(block => block.type === 'tool-call').length, 2)
    assert.equal(blocks[0].id, 'call-abc')
    assert.equal(blocks[1].id, phantomId(9))
    await harness.dispose()
  })

  it('cannot cover a block emitted by a listener mounted outside it', async () => {
    const harness = await world()
    harness.ctx.on('llm/stream', async function* (_options, next) {
      yield* next()
      yield* streamOf(INJECTED)
    }, { prepend: true })
    const blocks = assemble(await collect(harness.stream(ORDINARY)))
    assert.equal(blocks[1].id, '')
    assert.equal(admit(toolResultRow(blocks[1].id)).admitted, false)
    await harness.dispose()
  })

  it('sits outside a listener that was already mounted when it arrived', async () => {
    // `prepend` is the position, and the position is the repair. A deployment that
    // already has its own `llm/stream` listener needs the guard *outside* it: a
    // block that listener contributes after the adapter's stream ends has to be
    // covered too, or the repair depends on mount order. The guard is mounted
    // last here — the order the README advises, and the one a late addition to an
    // existing composition has.
    const harness = await world({ plugin: false })
    harness.ctx.on('llm/stream', async function* (_options, next) {
      yield* next()
      yield* streamOf(INJECTED)
    })
    await harness.mount()
    const blocks = assemble(await collect(harness.stream(ORDINARY)))
    assert.equal(blocks[0].id, 'call-abc')
    assert.equal(blocks[1].id, phantomId(9))
    await harness.dispose()
  })

  it('is reached even when the dispatch filters by context', async () => {
    const harness = await world()
    // Cordis filters listeners by the dispatching service's isolation, and the
    // guard registers as `global` so a scoped mount still covers every call.
    const excluding = { [Symbol.for('cordis.filter')]: () => false }
    const blocks = assemble(await collect(
      harness.ctx.waterfall(excluding, 'llm/stream', { provider: 'target', model: 'model-1', messages: [] }, () => streamOf(PHANTOM)),
    ))
    assert.equal(blocks[1].id, phantomId(1))
    await harness.dispose()
  })
})

describe('fail-open at the plugin', () => {
  it('survives a request whose accessor throws while a decision is being recorded', async () => {
    const harness = await world()
    const hostile = {
      provider: 'target',
      model: 'model-1',
      messages: [],
      get sessionId() { throw new Error('the request accessor threw') },
    }
    const emitted = await collect(harness.raw(PHANTOM, hostile))
    // Every chunk still reached the consumer, in order, and the repair the gate
    // had applied is the one it kept.
    assert.deepEqual(emitted.map(chunk => chunk.type), PHANTOM.map(chunk => chunk.type))
    assert.equal(toolCall(assemble(emitted)).id, phantomId(1))
    const snapshot = service(harness).snapshot()
    assert.equal(snapshot.counters.errors, 1)
    assert.match(logText(harness.logged), /stopped guarding one stream after an internal failure/)
    await harness.dispose()
  })
})

describe('the service', () => {
  it('states what it cannot do, and resets', async () => {
    const harness = await world()
    await run(harness, PHANTOM)
    const before = service(harness).snapshot()
    assert.ok(before.notCovered.length >= 5)
    assert.match(before.notCovered.join('\n'), /Preventive only/)
    service(harness).reset()
    const after = service(harness).snapshot()
    assert.deepEqual(after.counters.verdicts, { keep: 0, answer: 0, suppress: 0 })
    assert.equal(after.counters.streams, 0)
    assert.deepEqual(after.recent, [])
    assert.deepEqual(after.notCovered, before.notCovered)
    await harness.dispose()
  })

  it('keeps no history when asked for none, and still counts', async () => {
    const harness = await world({ config: { historyLimit: 0 } })
    await run(harness, PHANTOM)
    const snapshot = service(harness).snapshot()
    assert.deepEqual(snapshot.recent, [])
    assert.equal(snapshot.counters.verdicts.answer, 1)
    await harness.dispose()
  })

  it('keeps only the most recent decisions up to the configured limit', async () => {
    // `0` is the one limit the record() guard already covers; any other bound is
    // the trim's job, and without it the history is a leak in a long session.
    const harness = await world({ config: { historyLimit: 2 } })
    for (const sessionId of ['sess-1', 'sess-2', 'sess-3']) {
      await collect(harness.stream(PHANTOM, { sessionId }))
    }
    const snapshot = service(harness).snapshot()
    assert.deepEqual(snapshot.recent.map(entry => entry.sessionId), ['sess-2', 'sess-3'])
    // Trimmed, not forgotten: every decision is still counted.
    assert.equal(snapshot.counters.verdicts.answer, 3)
    await harness.dispose()
  })
})
