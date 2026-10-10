/**
 * The one seam that reaches both the message the model's call becomes and the
 * record that call is replayed from — and the one rule that makes using it safe.
 *
 * ## The gap this closes
 *
 * Report #9215: a model emitted a tool call with **no identity at all** — an
 * empty `id` and an empty `name` — at the tail of a turn. The session never
 * recovered. What happened is an asymmetry at the durable write boundary:
 *
 * - the `tool/call` row is admitted unchecked, so `callId: ""` lands;
 * - its paired `tool/result` is refused by the V4 codec, which requires a
 *   nonempty `toolCallId` matching its tool source
 *   (`packages/session/session-format-v3-to-v4/src/tool-role.ts`:
 *   *"requires toolCallId matching its tool source"*);
 * - the refusal happens while the encoder is building the row, **before** the
 *   append commits, so nothing is written and the dangling `tool/call` stays the
 *   last word of that step;
 * - every later turn resumes from the same seq, re-computes the same result, and
 *   is refused again — the session is dead from that seq onward.
 *
 * The identity is decided before any of that, in the chunk stream: `BlockAssembler`
 * writes `partial.toolCallId ?? call-<index>` for a block that never stated an
 * id, and an empty string is not nullish, so the fallback never fires and the
 * block assembles with `id: ''`.
 *
 * ## Why this seam
 *
 * The `llm/stream` waterfall's **return value** is the only place where one
 * change reaches both halves of the problem. The loop consumes exactly that
 * value: it feeds a `AssistantStreamAttempt` that both assembles the durable
 * `assistant/message` *and* records the raw chunks for replay
 * (`packages/core/agent-loop/src/agent.ts`: `for await (const chunk of stream)`).
 * So a chunk repaired here is repaired in the message and in the replay record at
 * once, and the two cannot disagree afterwards.
 *
 * It is also the *last* such place. The request side of the same waterfall is a
 * read-only observation point — a loop-built request arrives deep-frozen — but
 * the returned stream is a value a listener may replace, which is what this
 * plugin relies on. For that reason the listener registers with `prepend: true`:
 * a waterfall's position is part of its meaning, and the repair must be the last
 * transformation before the consumer, not one an outer layer can undo.
 *
 * ## What it does not claim
 *
 * It is **preventive, not curative**. A session whose `tool/call` already landed
 * with an empty id cannot be repaired from here, and this plugin does not try:
 * fixing that needs the write path, which is core's. It also repairs identity
 * and nothing else — an empty tool *name* is left exactly as the model produced
 * it, because inventing a name would dispatch a tool the model never asked for,
 * while a nameless call fails honestly at the registry and its durable result
 * closes the transaction. Every one of those boundaries is stated on the
 * service's own `snapshot()`.
 *
 * @module @argszero/dsh-phantom-tool-call-guard
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { defaultConfig, normalizeConfig } from './config.ts'
import type { Config, GuardMode, Settings } from './config.ts'
import { guardChunks } from './stream.ts'
import type { Finding, Policy, Reason, Verdict } from './stream.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'phantom-tool-call-guard'

/**
 * The service this plugin is about.
 *
 * It never calls the registry — the seam is a chunk stream — but a composition
 * with no models has nothing for this guard to guard, and a mount that silently
 * listened to nothing would be indistinguishable from one that failed to load.
 */
export const inject = ['llm']

export type { Config, GuardMode, Settings } from './config.ts'
export { defaultConfig, normalizeConfig } from './config.ts'
export type { Finding, Policy, Reason, Verdict } from './stream.ts'
export { ChunkGate, guardChunks, phantomId } from './stream.ts'

/** Every verdict a finding can carry. */
export const VERDICTS: readonly Verdict[] = ['keep', 'answer', 'suppress']

/** Every reason a finding can carry, in the order the report lists them. */
export const REASONS: readonly Reason[] = [
  'identity-present',
  'empty-id',
  'id-lost-at-close',
  'id-never-arrived',
]

/** One decision, kept for the bounded history. */
export interface DecisionRecord {
  /** The route the guarded call was bound to. */
  readonly provider: string
  /** The model the guarded call was bound to. */
  readonly model: string
  /** The session the call belonged to, when the call names one. */
  readonly sessionId: string | undefined
  /** The stream index of the block, unchanged. */
  readonly index: number
  /** What was decided. */
  readonly verdict: Verdict
  /** The evidence the decision rested on. */
  readonly reason: Reason
  /** The id written, or the one a repairing mode would have written. */
  readonly written: string | undefined
  /** The tool name the stream declared, when it declared one. */
  readonly name: string | undefined
}

/** What the guard has seen and done, as a caller reads it back. */
export interface Counters {
  /** Chunk streams guarded. */
  readonly streams: number
  /** Guarded streams that failed inside this plugin and were passed through unchanged. */
  readonly errors: number
  /** Tracked tool-call blocks, by verdict. */
  readonly verdicts: Readonly<Record<Verdict, number>>
  /** Tracked tool-call blocks, by the evidence that produced the verdict. */
  readonly reasons: Readonly<Record<Reason, number>>
}

/** The read-only view `mode: 'observe'` and the tests both use. */
export interface Snapshot {
  readonly mode: GuardMode
  readonly settings: Settings
  readonly counters: Counters
  readonly recent: readonly DecisionRecord[]
  /**
   * What this plugin structurally cannot do, stated on every report.
   *
   * A guard that reports only its decisions leaves an operator unable to tell
   * "nothing needed repairing" from "the repair never ran" — and, worse here,
   * unable to tell a prevented session from a poisoned one it arrived too late
   * for.
   */
  readonly notCovered: readonly string[]
}

/** The service this plugin provides. */
export interface PhantomToolCallGuardService {
  /** Counters, recent decisions and the guard's own declared blind spots. */
  snapshot(): Snapshot
  /** Zero the counters and drop the retained history. */
  reset(): void
}

/** The name under which the service is provided. */
export const SERVICE = 'phantomToolCallGuard'

/**
 * The statements the plugin makes about its own blind spots.
 *
 * Each line is a boundary a reader could otherwise mistake for a bug: a log this
 * plugin is too late for, a defect in the name rather than the id, a layer
 * mounted outside it, the measuring mode, the abandoned stream, and the two ids
 * a repair can mint in one session.
 * @returns the lines the report carries.
 */
function blindSpots(): string[] {
  return [
    'Preventive only: a session whose `tool/call` already landed with an empty id cannot be repaired here. The refusal happens at the write boundary, before the append, and repairing that needs core.',
    'Only identity is repaired. An empty tool *name* is left as the model produced it: inventing a name would dispatch a tool the model never asked for, and a nameless call fails at the registry with a durable result that closes the transaction either way.',
    'Only layers mounted below this plugin are covered: a listener registered with `prepend` after this one runs outside it, so the repair it sees is not the stream the consumer receives.',
    '`observe` applies nothing. It decides, counts and reports exactly as `answer` would, so the two runs differ in nothing but the emitted stream.',
    'A stream the consumer abandons (an abort, a `break`) releases nothing: the chunks of a block still held are dropped with it. That is safe because the harness discards the tool calls of an interrupted attempt, and it means an interrupted turn neither needs nor gets a repair.',
    'The minted id is `call-phantom-<index>`, unique within a stream. Two *attempts* in one session can mint the same id; that is harmless unless the earlier attempt\'s `tool/result` never landed, in which case the id stays advertised-unsettled and only a whole-log relationship check would notice.',
  ]
}

/** A fresh, all-zero counter block. */
function zeroCounters(): {
  streams: number
  errors: number
  verdicts: Record<Verdict, number>
  reasons: Record<Reason, number>
} {
  return {
    streams: 0,
    errors: 0,
    verdicts: Object.fromEntries(VERDICTS.map(verdict => [verdict, 0])) as Record<Verdict, number>,
    reasons: Object.fromEntries(REASONS.map(reason => [reason, 0])) as Record<Reason, number>,
  }
}

/**
 * How a finding reads in one log line.
 *
 * The verb differs per mode on purpose: an operator reading `would write` knows
 * the deployment is measuring, and one reading `wrote` knows a durable record
 * was changed by this plugin.
 * @param finding - the decision.
 * @param mode - the mode that produced it.
 * @returns the sentence, without the plugin prefix.
 */
function sentence(finding: Finding, mode: GuardMode): string {
  const name = finding.name === undefined || finding.name.length === 0
    ? 'a call with no name'
    : `"${finding.name}"`
  switch (finding.reason) {
    case 'empty-id':
      return mode === 'observe'
        ? `index ${finding.index} (${name}) closed without an id; would write "${finding.written ?? ''}" so the call becomes answerable`
        : mode === 'suppress'
          ? `index ${finding.index} (${name}) closed without an id; dropped the block`
          : `index ${finding.index} (${name}) closed without an id; wrote "${finding.written ?? ''}" so the call becomes answerable`
    case 'id-lost-at-close':
      return mode === 'observe'
        ? `index ${finding.index} (${name}) lost its id at the closing block; would restore "${finding.written ?? ''}"`
        : mode === 'suppress'
          ? `index ${finding.index} (${name}) lost its id at the closing block; dropped the block`
          : `index ${finding.index} (${name}) lost its id at the closing block; restored "${finding.written ?? ''}"`
    case 'id-never-arrived':
      return `index ${finding.index} (${name}) never stated an id; left alone — the assembler's own fallback covers it`
    case 'identity-present':
      return `index ${finding.index} (${name}) stated an id`
  }
}

/**
 * Mount the plugin.
 *
 * `config` is whatever a loader entry passed, or `undefined` when it passed
 * nothing, so the default lives here. It cannot live in an exported `Config`:
 * Cordis reads `Config['~standard'].validate` off a plugin's `Config`, and a
 * plain defaults object has no such property, so naming one there makes the mount
 * throw before this function is called.
 * @param ctx - the plugin context.
 * @param config - the plugin configuration.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = normalizeConfig(config)
  const counters = zeroCounters()
  const recent: DecisionRecord[] = []

  const record = (entry: DecisionRecord): void => {
    if (settings.historyLimit === 0) return
    recent.push(entry)
    while (recent.length > settings.historyLimit) recent.shift()
  }

  const snapshot = (): Snapshot => ({
    mode: settings.mode,
    settings: { ...settings },
    counters: {
      streams: counters.streams,
      errors: counters.errors,
      verdicts: { ...counters.verdicts },
      reasons: { ...counters.reasons },
    },
    recent: recent.map(entry => ({ ...entry })),
    notCovered: blindSpots(),
  })

  const service: PhantomToolCallGuardService = {
    snapshot,
    reset: () => {
      const fresh = zeroCounters()
      counters.streams = fresh.streams
      counters.errors = fresh.errors
      for (const verdict of VERDICTS) counters.verdicts[verdict] = 0
      for (const reason of REASONS) counters.reasons[reason] = 0
      recent.length = 0
    },
  }

  if (settings.mode === 'off') {
    // The service is still provided. A mount that answered nothing at all would
    // be indistinguishable from a plugin that failed to load.
    ctx.provide(SERVICE, service)
    return
  }

  ctx.on('llm/stream', (options, next) => {
    counters.streams += 1
    const policy: Policy = {
      // `observe` decides exactly as `answer` does and applies nothing, so the
      // two runs are comparable: same verdicts, same counters, same log, and the
      // emitted stream as the only difference.
      decision: settings.mode === 'suppress' ? 'suppress' : 'answer',
      apply: settings.mode !== 'observe',
      onFinding: (finding) => {
        counters.verdicts[finding.verdict] += 1
        counters.reasons[finding.reason] += 1
        if (finding.reason === 'identity-present') return
        record({
          provider: options.provider,
          model: options.model,
          sessionId: options.sessionId,
          index: finding.index,
          verdict: finding.verdict,
          reason: finding.reason,
          written: finding.written,
          name: finding.name,
        })
        const line = `phantom-tool-call-guard: ${sentence(finding, settings.mode)}`
        if (finding.reason === 'id-never-arrived') ctx.logger.debug(line)
        else ctx.logger.info(line)
      },
      onFailure: (error) => {
        // Fail open, and say so. A guard whose bug breaks working model calls
        // would be a worse failure than the one it repairs, so a failure inside
        // it stops the guard for that stream and never reaches the consumer.
        counters.errors += 1
        if (settings.report) {
          ctx.logger.warn(
            `phantom-tool-call-guard: stopped guarding one stream after an internal failure, `
            + `its chunks are passed through unchanged: ${String(error)}`,
          )
        }
      },
    }
    // `prepend` is the position, and the position is the repair: it makes this
    // listener the last transformation the returned stream passes through, so
    // neither the assembler nor the replay record can see the unrepaired block.
    // `global` is because the stream is dispatched with the registry instance as
    // the listener's `this`, and a mount scoped to a profile must still cover it.
    return guardChunks(next(), policy)
  }, { global: true, prepend: true })

  if (settings.report) {
    ctx.logger.info(
      `phantom-tool-call-guard: mounted in ${settings.mode} mode on the llm/stream return value `
      + `(injected: ${inject.join(', ')})`,
    )
  }

  ctx.provide(SERVICE, service)
}

/**
 * The object a loader entry mounts: `vendor/loader` normalises a plugin module
 * with `exports.default ?? exports` and hands this to `ctx.plugin`, which reads
 * `Config['~standard'].validate` off it when it is present.
 *
 * `Config: defaultConfig` used to be exported here. `defaultConfig` is a plain
 * object rather than a schema, so the lookup found no `~standard` and every mount
 * of the installed package died with `TypeError: Cannot read properties of
 * undefined (reading 'validate')` before `apply` ran. The defaults reach a mount
 * through `apply(ctx, config = {})` instead, and the convention in this
 * repository's own packages is a real schema (`export const Config = z.object(…)`)
 * or no `Config` at all — never a plain object.
 */
export default { name, inject, apply }
