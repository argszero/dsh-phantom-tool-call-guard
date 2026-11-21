/**
 * The stream gate: the one place this plugin decides anything.
 *
 * It is deliberately a **pure chunk transformer** — no Cordis, no LLM registry,
 * no I/O. `offer()` takes chunks one at a time, `drain()` returns whatever has
 * become safe to emit, and `finish()` settles a stream that ended with a block
 * still open.
 *
 * ## The one invariant
 *
 * **What this gate emits is what it was given, in the order it was given**, with
 * a repair applied to the chunks it decided to repair and nothing removed except
 * in a suppressing mode. Order is why the buffer exists: a tool-call block is
 * *held* until its identity is settled, and anything that arrives behind it
 * waits in the same buffer, so a held block can never be overtaken. Nothing is
 * re-ordered and no index is renumbered — `BlockAssembler` keys blocks by index
 * and records their order at first sight, so the index is part of the stream's
 * meaning, not a label this gate may rewrite.
 *
 * ## Why an empty id and not a missing one
 *
 * The harness already has a fallback for a missing id: `BlockAssembler.assemble()`
 * writes `partial.toolCallId ?? call-<index>`. That fallback is defeated by the
 * empty string, because `''` is not nullish. So this gate acts in exactly one
 * place — where the harness's own guard is defeated — and the two halves of a
 * block are read differently because the assembler reads them differently:
 *
 * - **A `block-end` is authoritative.** `assemble()` returns a closed block
 *   verbatim, so the id on `block-end.block` is the id the durable `tool/call`
 *   will carry. An identity that is empty *or absent* there is decisive, whether
 *   or not any delta ran.
 * - **Without a `block-end`**, the id comes from the last delta, and `undefined`
 *   — a delta that carried no id at all — means the assembler's own fallback
 *   will fire. A block whose id was never *stated* is therefore left alone; only
 *   one stated as empty can poison, and only it is repaired.
 *
 * ## Why the name is decided the other way round
 *
 * An empty id has a repair and an empty name does not. The id is a value the
 * harness owns — it writes one into the durable call, and a substituted value
 * costs nothing but provenance. The name is the model's own act: inventing one
 * would dispatch a tool the model never asked for, so the only honest repair is
 * to withhold the block, and withholding is what makes the call disappear from
 * the message *and* from the replay record at once.
 *
 * Withholding is what a strict provider demands (report #13945: Kimi rejected
 * every later turn with 400 because a replayed history carried calls with empty
 * names). It is also survivable: `agent-loop` returns `{ kind: 'completed' }` for
 * an assistant message with no tool-call block, so a turn whose only tool call had
 * no name ends honestly instead of poisoning the session.
 *
 * The two halves therefore form one rule, in this order:
 *
 * 1. **The block names no tool** — no delta stated a name and the closing block
 *    stated none either — so it is withheld (`unnamed: 'suppress'`, the default)
 *    or, if the operator asked to keep such calls, handed to rule 2.
 * 2. **The id is unusable** — empty or absent where the closing block is
 *    authoritative — so it is repaired or withheld per `policy.decision`.
 *
 * A block the operator chose to keep still has to be answerable, which is why
 * rule 2 runs for it and why `unnamed: 'keep'` is the 0.1.1 posture exactly.
 *
 * ## How long a block is held
 *
 * Exactly as long as its identity is unknown — the id *and* the name, because
 * either can be the one thing that poisons the call. In the shipped adapters a
 * healthy block settles at most one chunk behind its start:
 *
 * - `llm-pi-ai` yields the id from the partial it captured at `toolcall_start`
 *   on the block's **first** `tool-call-delta`, and with it the name whenever the
 *   provider gave one (it omits `name` entirely when the provider gave none —
 *   which is exactly the block this plugin withholds);
 * - the DeepSeek Messages translator yields `block-start` and then, immediately,
 *   a `tool-call-delta` carrying `id` and `name` from the block it just built.
 *
 * So the common path buffers one `block-start` and releases it on the next
 * chunk. Only a block whose stream never states both halves is held to its
 * close — and that is the block this plugin exists for. Holding is not free (a
 * downstream consumer sees nothing of a held block), which is why the release is
 * driven by the *first* usable identity rather than by `block-end`: a long
 * streamed tool argument would otherwise arrive at the UI in one burst.
 *
 * @module @argszero/dsh-phantom-tool-call-guard/stream
 */

import type { StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'

/** What the gate decided about one tool-call block. */
export type Verdict =
  /** The block's identity is present (or covered by the assembler's own fallback). Nothing was done. */
  | 'keep'
  /** The block was given an identity. */
  | 'answer'
  /** The block was dropped. */
  | 'suppress'

/**
 * Why it decided that. Each reason is a distinct shape of evidence, because an
 * operator who can only read "repaired: 3" cannot tell a real repair from a
 * false positive.
 */
export type Reason =
  /** The block stated an identity and it was usable. */
  | 'identity-present'
  /** The block's identity was stated, and it was empty. */
  | 'empty-id'
  /** The block named no tool: no delta stated a name, and the closing block stated none either. */
  | 'empty-name'
  /** The deltas carried a usable id and the closing block arrived without one. */
  | 'id-lost-at-close'
  /** No chunk ever stated an id, so the assembler's own `?? call-<index>` covers this block. */
  | 'id-never-arrived'

/** One decision, as the service and the log report it. */
export interface Finding {
  /** The stream index of the block, unchanged. */
  readonly index: number
  /** What was decided. */
  readonly verdict: Verdict
  /** The evidence the decision rests on. */
  readonly reason: Reason
  /** The id written, or the one that would be written when the decision is not applied. */
  readonly written: string | undefined
  /** The tool name the stream declared, when it declared one. */
  readonly name: string | undefined
}

/** What the gate is allowed to do, and where it reports. */
export interface Policy {
  /** The repair a poisoned block with a usable name is decided to need. */
  readonly decision: 'answer' | 'suppress'
  /**
   * What a block that names no tool is decided to need.
   *
   * `suppress` is the default: no name can be invented, and a replayed history
   * carrying `name: ''` is what a strict provider rejects. `keep` is the 0.1.1
   * posture — the call is dispatched, fails at the registry and closes with a
   * `tool/result` — kept for an operator who wants to see such a call rather than
   * have it withheld.
   */
  readonly unnamed: 'suppress' | 'keep'
  /**
   * Whether that decision is applied to the emitted stream.
   *
   * `false` is the measuring posture: every block is judged exactly as it would
   * be, every finding is reported, and the stream is emitted unchanged. The two
   * runs then differ in nothing but the stream, which is what makes a
   * before/after comparison mean something.
   */
  readonly apply: boolean
  /** Called once per tracked block, with the decision. */
  readonly onFinding: (finding: Finding) => void
  /**
   * Called when this gate failed on one stream, once, after which every chunk of
   * that stream is passed through unchanged.
   *
   * The sink itself is the most likely source of such a failure — a logger that
   * throws, an exporter that rejects — so this is reported rather than thrown:
   * a guard whose bug breaks working model calls is a worse failure than the one
   * it repairs.
   */
  readonly onFailure?: (error: unknown) => void
}

/** A nonempty string, or `undefined` for anything else. */
function identity(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** One buffered chunk. `held` marks a chunk of a block whose identity is not settled. */
interface Slot {
  chunk: StreamChunk | undefined
  held: boolean
}

/** One tool-call block the gate is following. */
interface Tracked {
  readonly index: number
  /** The slots this block owns while it is held; empty once released. */
  slots: Slot[]
  /** The last id a delta stated (`''` included); `undefined` when no delta stated one. */
  stated: string | undefined
  /** The last nonempty name a delta stated. */
  name: string | undefined
  /** Whether this block's chunks are still waiting. */
  held: boolean
  /** Whether a `block-end` for this block has been decided (later ones are stragglers). */
  closed: boolean
}

/**
 * The identity this plugin writes when a block's identity is empty.
 *
 * Namespaced, and derived from the block's own stream index so two repairs in
 * one attempt can never collide. A reader who finds it in a log can tell at a
 * glance that the provider did not write it — which is the point: this plugin
 * puts a value into a durable record, and a value that looks like the provider's
 * would be a lie about provenance.
 * @param index - the block's stream index.
 * @returns the id to write.
 */
export function phantomId(index: number): string {
  return `call-phantom-${index}`
}

/** The same chunk with an id, touching only the fields that carry one. */
function withId(chunk: StreamChunk, id: string): StreamChunk {
  if (chunk.type === 'tool-call-delta') return { ...chunk, id: id as ToolCallId }
  if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
    return { ...chunk, block: { ...chunk.block, id: id as ToolCallId } }
  }
  return chunk
}

/**
 * The gate. One instance per stream; it holds no state across streams.
 *
 * Single-use per stream is a property, not a convention: `finish()` settles every
 * open block, and a second stream fed to the same instance would be judged
 * against the first one's indexes and against a buffer that no longer belongs to
 * it.
 */
export class ChunkGate {
  private readonly buffer: Slot[] = []
  private readonly tracked = new Map<number, Tracked>()

  /** @param policy - the configured decision and the finding sink. */
  constructor(private readonly policy: Policy) {}

  /**
   * Take one chunk from the source stream.
   * @param chunk - the next chunk, in stream order.
   */
  offer(chunk: StreamChunk): void {
    switch (chunk.type) {
      case 'block-start': {
        // Only a tool-call block is ever judged, and a repeated `block-start`
        // for an index the assembler already knows is ignored by it as well.
        if (chunk.blockType !== 'tool-call' || this.tracked.has(chunk.index)) {
          this.plain(chunk)
          return
        }
        this.hold(this.opened(chunk.index), chunk)
        return
      }

      case 'tool-call-delta': {
        // A delta-only protocol is explicitly supported by the assembler, so the
        // first delta may be the first evidence of the block — and it is judged
        // by the same rule as any other.
        const tracked = this.tracked.get(chunk.index) ?? this.opened(chunk.index)
        if (tracked.closed) {
          this.plain(chunk)
          return
        }
        if (typeof chunk.id === 'string') tracked.stated = chunk.id
        if (chunk.name !== undefined && chunk.name.length > 0) tracked.name = chunk.name
        if (!tracked.held) {
          this.plain(chunk)
          return
        }
        this.hold(tracked, chunk)
        // Both halves of the identity have arrived, so the block is ordinary.
        // Release it here rather than at `block-end` so a long argument stream
        // keeps reaching the consumer as it arrives. A delta that stated an id but
        // no name is *not* enough: whether the block names a tool at all is still
        // open, and a name that never arrives is the block this gate withholds.
        if (identity(chunk.id) !== undefined && tracked.name !== undefined) {
          this.settle(tracked, 'identity-present', 'keep')
        }
        return
      }

      case 'block-end': {
        if (chunk.block.type !== 'tool-call') {
          this.plain(chunk)
          return
        }
        const tracked = this.tracked.get(chunk.index)
        if (tracked === undefined) {
          // No `block-start` and no delta: this closing block is the block, and
          // the assembler will use it verbatim.
          const fresh = this.opened(chunk.index)
          this.hold(fresh, chunk)
          this.close(fresh, chunk.block.id, chunk.block.name)
          return
        }
        if (tracked.closed) {
          this.plain(chunk)
          return
        }
        if (tracked.held) {
          this.hold(tracked, chunk)
          this.close(tracked, chunk.block.id, chunk.block.name)
          return
        }
        // The deltas already stated a usable identity, so this block is ordinary
        // — but the closing block still has the last word, and a `block-end`
        // without an identity would *take that id away*: `assemble()` returns a
        // closed block verbatim, so the durable call would lose the id its own
        // stream declared. Restoring it is not a guess; it is the value the same
        // stream already stated, and the reason is reported separately from
        // `empty-id` for exactly that reason.
        const stated = identity(tracked.stated)
        if (identity(chunk.block.id) === undefined && stated !== undefined) {
          this.hold(tracked, chunk)
          this.settle(tracked, 'id-lost-at-close', this.policy.decision, stated)
          this.tracked.delete(chunk.index)
          return
        }
        this.plain(chunk)
        this.tracked.delete(chunk.index)
        return
      }

      default: {
        this.plain(chunk)
        return
      }
    }
  }

  /**
   * Everything that has become safe to emit, in order.
   * @returns the chunks, oldest first; empty while a held block is first in the buffer.
   */
  drain(): StreamChunk[] {
    const out: StreamChunk[] = []
    while (this.buffer.length > 0 && this.buffer[0]?.held !== true) {
      const slot = this.buffer.shift()
      if (slot?.chunk !== undefined) out.push(slot.chunk)
    }
    return out
  }

  /**
   * Settle a stream that ended.
   *
   * A block still held here was never closed, so it will be assembled from its
   * deltas — which is why an id that was never stated at all is left alone: the
   * assembler's `?? call-<index>` covers it, and reporting a repair there would
   * be this plugin taking credit for core's own behaviour.
   */
  finish(): void {
    for (const tracked of [...this.tracked.values()]) {
      if (!tracked.held) continue
      const stated = tracked.stated
      if (stated === undefined) this.settle(tracked, 'id-never-arrived', 'keep')
      else if (identity(stated) !== undefined) this.settle(tracked, 'identity-present', 'keep')
      else this.settle(tracked, 'empty-id', this.policy.decision)
    }
  }

  /**
   * Give up deciding on this stream and hand back everything still buffered, in
   * order and exactly once.
   *
   * The failure it exists for happens *after* a chunk was taken — in the repair,
   * in the drain, or in the caller's own finding sink — so the buffered copy is
   * the authoritative one and the chunk that was being offered is released with
   * it rather than emitted separately.
   */
  release(): StreamChunk[] {
    const out: StreamChunk[] = []
    for (const slot of this.buffer) {
      if (slot.chunk !== undefined) out.push(slot.chunk)
    }
    this.buffer.length = 0
    this.tracked.clear()
    return out
  }

  /** Open tracking for a block, held until its identity is settled. */
  private opened(index: number): Tracked {
    const tracked: Tracked = { index, slots: [], stated: undefined, name: undefined, held: true, closed: false }
    this.tracked.set(index, tracked)
    return tracked
  }

  /** Append a chunk that needs no decision. */
  private plain(chunk: StreamChunk): void {
    this.buffer.push({ chunk, held: false })
  }

  /** Append one of a held block's own chunks. */
  private hold(tracked: Tracked, chunk: StreamChunk): void {
    const slot: Slot = { chunk, held: true }
    this.buffer.push(slot)
    tracked.slots.push(slot)
  }

  /**
   * Decide a block whose stream has closed.
   * @param tracked - the block being settled.
   * @param id - the id on the closing block, which the assembler uses verbatim.
   * @param name - the name on the closing block. It is the last word on whether
   *   this block names a tool at all, and it is never rewritten: the only choice
   *   the name offers is to keep the block or withhold it.
   */
  private close(tracked: Tracked, id: unknown, name: string): void {
    tracked.closed = true
    if (tracked.name === undefined && name.length > 0) tracked.name = name
    // Nothing named a tool: no delta did, and the closing block — which the
    // assembler uses verbatim — does not either. There is no honest repair for
    // this. A name this gate wrote would dispatch a tool the model never asked
    // for, and a call replayed with an empty name is exactly what a strict
    // provider rejects for every later turn (#13945). Withholding the block whole
    // removes it from the message and from the replay record at once, and an
    // assistant message with no tool-call block completes the turn honestly.
    if (tracked.name === undefined && this.policy.unnamed === 'suppress') {
      this.settle(tracked, 'empty-name', 'suppress')
      return
    }
    if (identity(id) !== undefined) {
      this.settle(tracked, 'identity-present', 'keep')
      return
    }
    // The closing block carries no identity, and it is the block the assembler
    // will use — so the call is unanswerable as streamed. If a delta had stated
    // an id, that is the one the call was going to have, and the repair puts it
    // back; otherwise the block never had one to lose.
    const stated = identity(tracked.stated)
    this.settle(tracked, stated === undefined ? 'empty-id' : 'id-lost-at-close', this.policy.decision, stated)
  }

  /**
   * Release a block and report what was decided.
   * @param tracked - the block to release.
   * @param reason - the evidence for the decision.
   * @param decision - what is to be done with the block. The gate chooses it per
   *   arm, so the only question left here is whether this mount is acting at all.
   * @param stated - an id the stream itself declared, when the repair restores one.
   */
  private settle(
    tracked: Tracked,
    reason: Reason,
    decision: Verdict,
    stated: string | undefined = undefined,
  ): void {
    const written = decision === 'answer' ? stated ?? phantomId(tracked.index) : undefined
    for (const slot of tracked.slots) {
      slot.held = false
      if (!this.policy.apply) continue
      if (decision === 'suppress') {
        slot.chunk = undefined
        continue
      }
      if (written !== undefined && slot.chunk !== undefined) slot.chunk = withId(slot.chunk, written)
    }
    tracked.slots = []
    tracked.held = false
    this.report(tracked, decision, reason, written)
  }

  /** Publish one decision. */
  private report(tracked: Tracked, verdict: Verdict, reason: Reason, written: string | undefined): void {
    this.policy.onFinding({ index: tracked.index, verdict, reason, written, name: tracked.name })
  }
}

/**
 * Guard one stream: wrap the source so a tool call that could never be answered is
 * repaired or removed before the consumer — and the durable record that consumer
 * writes — sees it. Nothing else about the stream changes.
 * @param source - the chunk stream the `llm/stream` waterfall produced.
 * @param policy - the configured decision and the finding sink.
 * @returns the guarded stream. Abandoning the consumer (an abort, a `break`)
 *   simply closes the source: nothing held is released, because a stream that
 *   was cut short has no more chunks to emit, and the harness discards the tool
 *   calls of an interrupted attempt anyway.
 */
export async function* guardChunks(
  source: AsyncIterable<StreamChunk>,
  policy: Policy,
): AsyncIterable<StreamChunk> {
  const gate = new ChunkGate(policy)
  let failed = false
  for await (const chunk of source) {
    if (failed) {
      yield chunk
      continue
    }
    try {
      gate.offer(chunk)
      for (const emitted of gate.drain()) yield emitted
    } catch (error: unknown) {
      failed = true
      policy.onFailure?.(error)
      // Everything the gate had taken, released in order and unchanged. The
      // chunk being offered is in that buffer: the failure it can reach — a
      // repair, a drain, the caller's sink — happens after the chunk was taken.
      for (const emitted of gate.release()) yield emitted
    }
  }
  if (failed) return
  try {
    gate.finish()
    for (const emitted of gate.drain()) yield emitted
  } catch (error: unknown) {
    policy.onFailure?.(error)
    for (const emitted of gate.release()) yield emitted
  }
}
