/**
 * The gate, unit by unit.
 *
 * `ChunkGate` is the whole decision, so it is tested directly and exhaustively —
 * every chunk shape it can be handed, every verdict it can reach, and the two
 * properties the rest of the package rests on: **order is preserved** and a held
 * block is never overtaken.
 *
 * ## Two fixtures, because there are two arms
 *
 * A tool-call block can fail in two independent ways, and 0.2 decides them
 * differently: an empty **id** on a call that names a tool is repaired, and a
 * block that names **no tool** is withheld. So the phantom is split in two — a
 * named call with no id, and a block with neither — and every arm is asserted on
 * the fixture it is actually about. Running the id arm on the unnamed fixture
 * would measure the other arm and call it a pass.
 *
 * @module test/stream.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ChunkGate, guardChunks, phantomId } from '../lib/stream.js'
import { collect, streamOf } from './harness.mjs'

/** A gate whose findings are collected, in either applied or measuring posture. */
function gate(options = {}) {
  const findings = []
  const failures = []
  const instance = new ChunkGate({
    decision: options.decision ?? 'answer',
    unnamed: options.unnamed ?? 'suppress',
    apply: options.apply ?? true,
    onFinding: finding => { findings.push(finding) },
    onFailure: error => { failures.push(error) },
  })
  return { instance, findings, failures }
}

/** Feed chunks and return everything the gate released, in order. */
function run(options, chunks, finish = true) {
  const { instance, findings } = gate(options)
  const emitted = []
  for (const chunk of chunks) {
    instance.offer(chunk)
    emitted.push(...instance.drain())
  }
  if (finish) {
    instance.finish()
    emitted.push(...instance.drain())
  }
  return { emitted, findings }
}

/** The id arm's subject: a call that names a tool and lost its id (pi-ai's `known?.id ?? ''`). */
const ID_LOST_DELTAS = [
  { type: 'block-start', index: 1, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 1, id: '', name: 'read', argumentsDelta: '{"a":' },
  { type: 'tool-call-delta', index: 1, id: '', name: 'read', argumentsDelta: '1}' },
]

/** The same call, closed by a block-end that states the empty id as well. */
const ID_LOST_CLOSED = [
  ...ID_LOST_DELTAS,
  { type: 'block-end', index: 1, block: { type: 'tool-call', id: '', name: 'read', arguments: '{"a":1}' } },
]

/**
 * The name arm's subject, and the phantom of both reports: #9215 wrote one of
 * these, and #13945 replayed one to a provider that refused every later turn.
 * No delta states a name, and the closing block states it empty.
 */
const UNNAMED_DELTAS = [
  { type: 'block-start', index: 1, blockType: 'tool-call' },
  { type: 'tool-call-delta', index: 1, id: '', argumentsDelta: '{"a":' },
  { type: 'tool-call-delta', index: 1, id: '', argumentsDelta: '1}' },
]

/** The same unnamed block, closed. */
const UNNAMED_CLOSED = [
  ...UNNAMED_DELTAS,
  { type: 'block-end', index: 1, block: { type: 'tool-call', id: '', name: '', arguments: '{"a":1}' } },
]

describe('ChunkGate: an ordinary tool call', () => {
  it('is emitted exactly as it arrived', () => {
    const chunks = [
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: 'call-abc', name: 'read', argumentsDelta: '{}' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-abc', name: 'read', arguments: '{}' } },
    ]
    const { emitted, findings } = run({}, chunks)
    assert.deepEqual(emitted, chunks)
    assert.deepEqual(findings.map(finding => [finding.verdict, finding.reason]), [['keep', 'identity-present']])
    assert.equal(findings[0].written, undefined)
  })

  it('is released as soon as both halves of its identity arrive, not at the closing block', () => {
    const { instance } = gate()
    instance.offer({ type: 'block-start', index: 1, blockType: 'tool-call' })
    assert.deepEqual(instance.drain(), [])
    instance.offer({ type: 'tool-call-delta', index: 1, id: 'call-abc', name: 'read', argumentsDelta: '' })
    assert.equal(instance.drain().length, 2)
  })

  it('is held when the delta states an id but no name, because the name is still open', () => {
    // The delta alone cannot acquit the block: a call that never states a name is
    // the block this gate withholds, so the release waits for the closing block.
    const { instance } = gate()
    instance.offer({ type: 'block-start', index: 1, blockType: 'tool-call' })
    instance.offer({ type: 'tool-call-delta', index: 1, id: 'call-abc', argumentsDelta: '{}' })
    assert.deepEqual(instance.drain(), [])
    instance.offer({ type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-abc', name: 'read', arguments: '{}' } })
    assert.deepEqual(instance.drain().map(chunk => chunk.type), ['block-start', 'tool-call-delta', 'block-end'])
  })
})

describe('ChunkGate: an empty id on a call that names a tool', () => {
  it('is repaired in every chunk that carries one', () => {
    const { emitted, findings } = run({}, ID_LOST_CLOSED)
    assert.deepEqual(findings.map(finding => [finding.verdict, finding.reason]), [['answer', 'empty-id']])
    assert.equal(findings[0].written, phantomId(1))
    const deltas = emitted.filter(chunk => chunk.type === 'tool-call-delta')
    assert.deepEqual(deltas.map(chunk => chunk.id), [phantomId(1), phantomId(1)])
    const close = emitted.find(chunk => chunk.type === 'block-end')
    assert.equal(close.block.id, phantomId(1))
    // Nothing else about the chunks moved.
    assert.deepEqual(deltas.map(chunk => chunk.argumentsDelta), ['{"a":', '1}'])
    assert.equal(close.block.arguments, '{"a":1}')
    assert.equal(close.block.name, 'read')
  })

  it('is repaired when the stream ends without closing the block', () => {
    const { emitted, findings } = run({}, ID_LOST_DELTAS)
    assert.deepEqual(findings.map(finding => [finding.verdict, finding.reason]), [['answer', 'empty-id']])
    assert.deepEqual(emitted.filter(chunk => chunk.type === 'tool-call-delta').map(chunk => chunk.id), [phantomId(1), phantomId(1)])
  })

  it('is repaired when the only chunk of the block is its closing block', () => {
    const chunks = [{ type: 'block-end', index: 3, block: { type: 'tool-call', id: '', name: 'write', arguments: '{}' } }]
    const { emitted, findings } = run({}, chunks)
    assert.deepEqual(findings.map(finding => [finding.verdict, finding.reason]), [['answer', 'empty-id']])
    assert.equal(emitted[0].block.id, phantomId(3))
    assert.equal(emitted[0].block.name, 'write')
    // The name is reported so the log line can name the call, and is never
    // written back into the stream.
    assert.equal(findings[0].name, 'write')
  })

  it('is repaired when the closing block omits the id the deltas stated', () => {
    const chunks = [
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 2, id: 'call-real', name: 'read', argumentsDelta: '{}' },
      // `brandString` is a cast, so an adapter holding no id emits `undefined`
      // here rather than `''` — and a closed block is used verbatim, so this
      // would replace the id the same stream already stated.
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: undefined, name: 'read', arguments: '{}' } },
    ]
    const { emitted, findings } = run({}, chunks)
    // Two decisions for one block, and both are true: the identity was present
    // when the deltas were released, and it was gone when the block closed.
    assert.deepEqual(
      findings.map(finding => [finding.verdict, finding.reason]),
      [['keep', 'identity-present'], ['answer', 'id-lost-at-close']],
    )
    // The id restored is the one the stream itself declared, not a minted one.
    assert.equal(findings[1].written, 'call-real')
    assert.equal(emitted[2].block.id, 'call-real')
  })

  it('keeps a closing block that supplies the identity the deltas lacked', () => {
    const chunks = [
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 2, id: '', argumentsDelta: '{}' },
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call-late', name: 'read', arguments: '{}' } },
    ]
    const { emitted, findings } = run({}, chunks)
    assert.deepEqual(findings.map(finding => [finding.verdict, finding.reason]), [['keep', 'identity-present']])
    assert.deepEqual(emitted, chunks)
  })

  it('is minted per block index, so two phantoms in one stream stay distinct', () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: '', name: 'read', arguments: '{}' } },
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: '', name: 'read', arguments: '{}' } },
    ]
    const { findings } = run({}, chunks)
    assert.deepEqual(findings.map(finding => finding.written), [phantomId(0), phantomId(2)])
  })
})

describe('ChunkGate: a block that names no tool', () => {
  it('is withheld whole, so no call without a name reaches the consumer', () => {
    const { emitted, findings } = run({}, UNNAMED_CLOSED)
    // The start, the deltas and the close all leave the stream: the assembler
    // never sees the block, so there is nothing to dispatch and nothing to
    // replay to a provider that would reject it.
    assert.deepEqual(emitted, [])
    assert.deepEqual(findings.map(finding => [finding.verdict, finding.reason]), [['suppress', 'empty-name']])
    assert.equal(findings[0].written, undefined)
    assert.equal(findings[0].name, undefined)
  })

  it('is held from its first delta, which is what makes withholding possible at all', () => {
    // A delta that states an id but no name is not evidence of a named call, so
    // nothing of this block may have been released by the time it closes.
    const { instance, findings } = gate()
    instance.offer({ type: 'block-start', index: 1, blockType: 'tool-call' })
    assert.deepEqual(instance.drain(), [])
    instance.offer({ type: 'tool-call-delta', index: 1, id: 'call-ok', argumentsDelta: '{}' })
    assert.deepEqual(instance.drain(), [])
    instance.offer({ type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-ok', name: '', arguments: '{}' } })
    assert.deepEqual(instance.drain(), [])
    assert.deepEqual(findings.map(finding => finding.reason), ['empty-name'])
  })

  it('is kept when the operator asks for such calls, and then its id is repaired like any other', () => {
    // `unnamed: 'keep'` is the 0.1.1 posture: the block stays exactly as the model
    // produced it, and only the id it lacks is supplied.
    const { emitted, findings } = run({ unnamed: 'keep' }, UNNAMED_CLOSED)
    assert.deepEqual(findings.map(finding => [finding.verdict, finding.reason]), [['answer', 'empty-id']])
    assert.equal(findings[0].written, phantomId(1))
    assert.equal(emitted.length, UNNAMED_CLOSED.length)
    assert.equal(emitted[3].block.name, '')
    assert.equal(emitted[3].block.id, phantomId(1))
  })

  it('leaves an unclosed unnamed block to the assembler and the truncation path', () => {
    // A stream that ended mid-block never stated what the block meant, so the name
    // is not decided from its absence; only the id arm runs.
    const { emitted, findings } = run({}, UNNAMED_DELTAS)
    assert.deepEqual(findings.map(finding => [finding.verdict, finding.reason]), [['answer', 'empty-id']])
    assert.equal(emitted.length, UNNAMED_DELTAS.length)
  })
})

describe('ChunkGate: an id that was never stated', () => {
  it('is left alone, because the assembler falls back for exactly that case', () => {
    const chunks = [
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, name: 'read', argumentsDelta: '{}' },
    ]
    const { emitted, findings } = run({}, chunks)
    assert.deepEqual(findings.map(finding => [finding.verdict, finding.reason]), [['keep', 'id-never-arrived']])
    assert.deepEqual(emitted, chunks)
  })
})

describe('ChunkGate: order', () => {
  it('never lets a later chunk overtake a block whose identity is unsettled', () => {
    const before = { type: 'text-delta', index: 0, text: 'before' }
    const after = { type: 'text-delta', index: 2, text: 'after' }
    const close = { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-ok', name: '', arguments: '{}' } }
    const { instance } = gate()
    for (const chunk of [...UNNAMED_DELTAS, after, before]) instance.offer(chunk)
    // Block 1 is still open and its name is still unknown, so nothing behind it
    // may be released — not even chunks that belong to other blocks.
    assert.deepEqual(instance.drain(), [])
    instance.offer(close)
    const emitted = instance.drain()
    // Withheld, and everything behind it follows in the order it was given.
    assert.deepEqual(emitted, [after, before])
  })

  it('releases other blocks normally once the held one is settled', () => {
    const leading = { type: 'text-delta', index: 0, text: 'lead' }
    const { emitted } = run({}, [leading, ...ID_LOST_CLOSED])
    assert.deepEqual(emitted[0], leading)
    assert.equal(emitted.length, 5)
  })
})

describe('ChunkGate: the measuring and suppressing postures', () => {
  it('decides exactly as answer does while emitting what it received', () => {
    const { emitted, findings } = run({ apply: false }, ID_LOST_CLOSED)
    assert.deepEqual(emitted, ID_LOST_CLOSED)
    assert.deepEqual(
      findings.map(finding => [finding.verdict, finding.reason, finding.written]),
      [['answer', 'empty-id', phantomId(1)]],
    )
  })

  it('reports a withheld block without withholding it while measuring', () => {
    // The measuring posture has to be able to answer "would this have cost me a
    // call?" without costing one, which is the whole point of running it first.
    const { emitted, findings } = run({ apply: false }, UNNAMED_CLOSED)
    assert.deepEqual(emitted, UNNAMED_CLOSED)
    assert.deepEqual(findings.map(finding => [finding.verdict, finding.reason]), [['suppress', 'empty-name']])
  })

  it('drops the block and nothing else', () => {
    const leading = { type: 'text-delta', index: 0, text: 'lead' }
    const trailing = { type: 'finish', reason: { kind: 'tool-calls' } }
    const { emitted, findings } = run({ decision: 'suppress' }, [leading, ...ID_LOST_CLOSED, trailing])
    assert.deepEqual(emitted, [leading, trailing])
    assert.deepEqual(findings.map(finding => [finding.verdict, finding.reason]), [['suppress', 'empty-id']])
    assert.equal(findings[0].written, undefined)
  })
})

describe('ChunkGate: chunks it has no opinion about', () => {
  it('passes every other chunk type straight through', () => {
    const chunks = [
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hi' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hi' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const { emitted, findings } = run({}, chunks)
    assert.deepEqual(emitted, chunks)
    assert.deepEqual(findings, [])
  })

  it('ignores a repeated block-start and a repeated closing block', () => {
    const chunks = [
      ...ID_LOST_CLOSED,
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: '', name: 'read', arguments: '{}' } },
    ]
    const { emitted, findings } = run({}, chunks)
    assert.equal(findings.length, 1)
    // The block is decided once and every chunk still leaves, in order; what the
    // assembler does with the stragglers (it ignores them) is its own business.
    assert.equal(emitted.length, 6)
    assert.equal(emitted[1].id, phantomId(1))
  })
})

describe('ChunkGate: settling twice', () => {
  it('does not emit a block twice when finish follows a closed block', () => {
    const { instance, findings } = gate()
    for (const chunk of ID_LOST_CLOSED) instance.offer(chunk)
    const once = instance.drain()
    instance.finish()
    assert.deepEqual(instance.drain(), [])
    assert.equal(once.length, ID_LOST_CLOSED.length)
    assert.equal(findings.length, 1)
  })

  it('drops everything buffered when the stream is abandoned', () => {
    const { instance } = gate()
    for (const chunk of UNNAMED_DELTAS) instance.offer(chunk)
    assert.deepEqual(instance.drain(), [])
    assert.deepEqual(instance.release().map(chunk => chunk.type), ['block-start', 'tool-call-delta', 'tool-call-delta'])
    assert.deepEqual(instance.drain(), [])
  })
})

describe('guardChunks', () => {
  it('emits the repaired stream in order', async () => {
    const emitted = await collect(guardChunks(streamOf(ID_LOST_CLOSED), {
      decision: 'answer',
      unnamed: 'suppress',
      apply: true,
      onFinding: () => {},
    }))
    assert.equal(emitted.length, ID_LOST_CLOSED.length)
    assert.equal(emitted[3].block.id, phantomId(1))
    assert.deepEqual(emitted.map(chunk => chunk.type), ID_LOST_CLOSED.map(chunk => chunk.type))
  })

  it('withholds an unnamed block at the seam itself, not only inside the gate', async () => {
    const emitted = await collect(guardChunks(streamOf(UNNAMED_CLOSED), {
      decision: 'answer',
      unnamed: 'suppress',
      apply: true,
      onFinding: () => {},
    }))
    assert.deepEqual(emitted, [])
  })

  it('fails open: a throwing finding sink costs the verdict, not the stream', async () => {
    const failures = []
    const emitted = await collect(guardChunks(streamOf(ID_LOST_CLOSED), {
      decision: 'answer',
      unnamed: 'suppress',
      apply: true,
      onFinding: () => { throw new Error('the sink is a logger, and loggers throw') },
      onFailure: error => { failures.push(error) },
    }))
    // Every chunk still leaves, in order. The repair the gate had already
    // applied is kept rather than reverted: reverting it would let a broken
    // logger decide that a session stays poisoned.
    assert.deepEqual(emitted.map(chunk => chunk.type), ID_LOST_CLOSED.map(chunk => chunk.type))
    assert.equal(emitted[3].block.id, phantomId(1))
    assert.equal(failures.length, 1)
    assert.match(String(failures[0]), /loggers throw/)
  })

  it('keeps passing chunks through after a failure', async () => {
    let calls = 0
    const trailing = { type: 'finish', reason: { kind: 'stop' } }
    const emitted = await collect(guardChunks(streamOf([...ID_LOST_CLOSED, trailing]), {
      decision: 'answer',
      unnamed: 'suppress',
      apply: true,
      onFinding: () => { calls += 1; throw new Error('nope') },
      onFailure: () => {},
    }))
    assert.equal(calls, 1)
    assert.equal(emitted.length, ID_LOST_CLOSED.length + 1)
    assert.deepEqual(emitted[emitted.length - 1], trailing)
  })

  it('releases a held block when the failure happens at the end of the stream', async () => {
    const emitted = await collect(guardChunks(streamOf(ID_LOST_DELTAS), {
      decision: 'answer',
      unnamed: 'suppress',
      apply: true,
      onFinding: () => { throw new Error('the sink throws only at settlement') },
      onFailure: () => {},
    }))
    assert.equal(emitted.length, ID_LOST_DELTAS.length)
    assert.deepEqual(emitted.map(chunk => chunk.type), ID_LOST_DELTAS.map(chunk => chunk.type))
    assert.equal(emitted[1].id, phantomId(1))
  })

  it('drops the chunks of a block still held when the consumer walks away', async () => {
    // A block whose identity is settled streams through immediately; the held
    // one behind it never reaches a consumer that stops reading, which is the
    // documented behaviour for an interrupted attempt.
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'before' },
      ...UNNAMED_DELTAS,
    ]
    const emitted = []
    for await (const chunk of guardChunks(streamOf(chunks), { decision: 'answer', unnamed: 'suppress', apply: true, onFinding: () => {} })) {
      emitted.push(chunk)
      if (emitted.length === 2) break
    }
    assert.deepEqual(emitted.map(chunk => chunk.type), ['block-start', 'text-delta'])
  })
})
