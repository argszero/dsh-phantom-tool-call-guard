/**
 * The integration harness: a REAL cordis context, the REAL `LlmRuntime`, and the
 * REAL `llm/stream` waterfall.
 *
 * Nothing about the seam is simulated. The plugin listens on `llm/stream`, and
 * this harness dispatches **that** waterfall — `ctx.waterfall(ctx.llm,
 * 'llm/stream', options, () => source)` — with the registry instance as the
 * listener `this`, exactly as `LlmRuntime.streamWithRegistration` does. So what
 * is under test is Cordis' own dispatch: the same listener list, the same
 * `prepend` placement, the same `next()` composition, the same `global` filter
 * bypass.
 *
 * What is fabricated is the *subject*: the chunk stream a provider would have
 * produced, handed in as the innermost `next`. That is not a simulation of the
 * thing under test either — it is the input to it. The two harness pieces that
 * *do* the work downstream of the gate are real and shipped:
 *
 * - `BlockAssembler` turns whatever the gate emits into the durable blocks, so
 *   the assertion "the id in the assembled call is nonempty" is measured with the
 *   same code the loop uses;
 * - `assertV4RowAdmission` is the write boundary itself, so the assertion "this
 *   `tool/result` would have been refused before the repair and is admitted
 *   after it" is measured with the shipped validator rather than a paraphrase of
 *   it.
 *
 * ## The unrepaired arm
 *
 * `plugin: false` mounts everything else and leaves this plugin out. It is what
 * turns "the repaired call is answerable" into "the plugin made it answerable",
 * which is the only form of the claim worth testing — and it is also how the
 * suite reproduces the report: without the plugin, the phantom assembles to
 * `id: ''` and its `tool/result` is refused.
 *
 * @module test/harness
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { BlockAssembler, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { assertV4RowAdmission } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import * as plugin from '../lib/index.js'

/**
 * A stream of chunks, as the adapter would have yielded them.
 * @param chunks - the chunks, in stream order.
 * @returns an async iterable over them.
 */
export async function* streamOf(chunks) {
  for (const chunk of chunks) yield chunk
}

/**
 * Drain an async iterable into an array.
 * @param iterable - the iterable to drain.
 * @returns every value, in order.
 */
export async function collect(iterable) {
  const out = []
  for await (const value of iterable) out.push(value)
  return out
}

/** A minimal request: the plugin reads only route, session and nothing else. */
export function request(options = {}) {
  return {
    provider: options.provider ?? 'target',
    model: options.model ?? 'model-1',
    messages: options.messages ?? [],
    ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
  }
}

/**
 * Mount a real context with the real LLM registry.
 *
 * `plugin: false` mounts everything else and leaves this plugin out — the control
 * arm. `config` is the plugin's configuration.
 * @param spec - `plugin`, `config`.
 * @returns the context, the captured log, the mount handle, and the dispatch.
 */
export async function world(spec = {}) {
  const ctx = new Context({})
  const logged = []
  ctx.logger.exporter({ levels: { default: 3 }, export: message => { logged.push(message) } })
  await ctx.plugin(LlmRuntime)
  const harness = {
    ctx,
    logged,
    fork: undefined,
    /**
     * Dispatch the real `llm/stream` waterfall and return what the consumer
     * would receive.
     * @param source - the chunk stream standing in for the adapter's output.
     * @param options - the request.
     * @returns the waterfall's return value.
     */
    stream(source, options = {}) {
      return ctx.waterfall(ctx.llm, 'llm/stream', request(options), () => streamOf(source))
    },
    /**
     * Dispatch with a request handed over verbatim — for subjects that must be
     * objects no helper would build, such as one with a hostile accessor.
     * @param source - the chunk stream standing in for the adapter's output.
     * @param options - the request, exactly as given.
     * @returns the waterfall's return value.
     */
    raw(source, options) {
      return ctx.waterfall(ctx.llm, 'llm/stream', options, () => streamOf(source))
    },
    async mount() {
      // `plugin` is this module's namespace; a loader entry mounts its **default**
      // export (`exports.default ?? exports`), and the two differ by the `Config` key.
      // `plugin: 'default'` mounts the object a profile entry actually reaches — see
      // test/mount.spec.mjs for the defect that difference hides.
      harness.fork = await ctx.plugin(spec.plugin === 'default' ? plugin.default : plugin, spec.config ?? {})
      return harness
    },
    async dispose() {
      await harness.fork?.dispose()
      harness.fork = undefined
    },
  }
  if (spec.plugin !== false) await harness.mount()
  return harness
}

/** The service this plugin provides, or `undefined` when it did not mount it. */
export function service(harness) {
  return harness.ctx.get('phantomToolCallGuard')
}

/**
 * Assemble whatever the harness emitted, with the shipped assembler.
 * @param chunks - the emitted chunks.
 * @returns the assembled blocks, in stream order.
 */
export function assemble(chunks) {
  const assembler = new BlockAssembler()
  for (const chunk of chunks) assembler.push(chunk)
  return assembler.blocks()
}

/** The first tool-call block of an assembled stream, or a helpful failure. */
export function toolCall(blocks) {
  const block = blocks.find(candidate => candidate.type === 'tool-call')
  if (block === undefined) throw new Error(`no tool-call block was assembled: ${JSON.stringify(blocks)}`)
  return block
}

/**
 * The durable `tool/result` row the loop writes for one assembled tool call.
 *
 * Built with the shipped factory, from the shipped `tool-calls.ts` call site:
 * `appendToolResult` writes `createToolResultMessage({ callId: block.id, ... })`
 * into `data.message` of a `tool/result` event.
 * @param callId - the id the assembled call carried.
 * @param seq - the row's seq.
 * @returns a row ready for the V4 codec's admission check.
 */
export function toolResultRow(callId, seq = 9) {
  return {
    type: 'tool/result',
    seq,
    time: 1,
    surfaceOp: 'append',
    data: {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'unknown tool' }],
        isError: true,
      }),
    },
  }
}

/**
 * Whether the write boundary would admit this row, and why not when it would not.
 *
 * The refusal is the whole point of the plugin, so the reason is returned rather
 * than swallowed: a test that asserts `false` should be able to say what the
 * codec objected to.
 * @param row - the row to admit.
 * @returns `{ admitted }` and, when refused, the codec's message.
 */
export function admit(row) {
  try {
    assertV4RowAdmission(row)
    return { admitted: true }
  } catch (error) {
    return { admitted: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/** The captured log as one string. */
export function logText(logged) {
  return logged.map(message => message.args.map(argument => String(argument)).join(' ')).join('\n')
}
