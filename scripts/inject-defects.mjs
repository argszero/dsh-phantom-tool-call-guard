/**
 * Defect injection: mutate the source, rebuild, run the suite, and require that
 * the mutation is caught. An arm whose mutation leaves the suite green is
 * SILENT — it proves nothing about the suite, and it is reported as a failure of
 * this harness rather than hidden.
 *
 * The suite imports `lib/*.js`, not `src/*.ts`, so every arm **emits** first: a
 * mutation that is never compiled is a mutation the suite cannot see, and a
 * mutation that does not compile is reported as TYPEFAIL, because it never
 * reached the suite either.
 *
 * Every arm below is a defect this plugin could plausibly have shipped — one
 * distinction it exists to make, removed one edit at a time. They are not
 * "does the test file import the module": each one deletes a rule the plugin
 * states in prose to its users, so a SILENT arm is a promise the package makes
 * that nothing checks.
 *
 * The arms this package would be *worthless* without are:
 *
 * - the **empty-versus-missing distinction** — the whole reason to exist is that
 *   the assembler's `?? call-<index>` fires for a *missing* id and is defeated by
 *   an *empty* one. An arm that reads an empty string as usable stops every
 *   repair; an arm that repairs a never-stated id takes credit for core's own
 *   fallback and dispatches a call nobody asked for.
 * - the **write boundary the plugin exists to satisfy** — the integration suite
 *   does not check "an id was written", it feeds the repaired block to the real
 *   V4 admission check. An arm that mints an id the boundary still refuses, or
 *   that writes the assembler's own fallback name, has to be caught by that.
 * - the **listener position** — the repair only means anything if it is the last
 *   transformation the consumer sees. `prepend` is the position.
 * - **`observe`** — the only way to measure before trusting. An arm that makes it
 *   act removes the operator's ability to see the decisions without taking them.
 * - **fail-open** — a guard whose bug breaks working model calls is worse than
 *   the failure it repairs.
 *
 * ```sh
 * node scripts/inject-defects.mjs                  # every arm
 * node scripts/inject-defects.mjs --filter=identity  # arms whose name matches
 * ```
 *
 * @module scripts/inject-defects
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TSC = resolve(ROOT, 'node_modules/typescript/bin/tsc')

/** Each arm names the one distinction it removes, and the file it lives in. */
const MUTATIONS = [
  {
    // The empty string is the whole bug. Read it as usable and every repair in
    // this package disappears — the block assembles with `id: ''` exactly as
    // before, and the session still dies.
    name: 'identity: an empty string is read as a usable id',
    file: 'src/stream.ts',
    edits: [["  return typeof value === 'string' && value.length > 0 ? value : undefined",
      "  return typeof value === 'string' ? value : undefined"]],
  },
  {
    // The other direction: reading *every* id as unusable repairs blocks that
    // never needed it, and reports a repair on ordinary traffic.
    name: 'identity: a stated id is never read as usable',
    file: 'src/stream.ts',
    edits: [["  return typeof value === 'string' && value.length > 0 ? value : undefined",
      '  return undefined']],
  },
  {
    // The minted id is namespaced so a reader can tell at a glance that the
    // provider did not write it. Minting the assembler's own spelling makes the
    // repair indistinguishable from what the harness would have written — and
    // for a *duplicated* index, indistinguishable from a real id.
    name: 'identity: the minted id is written as the assembler’s own fallback',
    file: 'src/stream.ts',
    edits: [['  return `call-phantom-${index}`', '  return `call-${index}`']],
  },
  {
    // `apply: false` is the measuring posture. Ignoring it makes `observe` act,
    // which removes the only way to see the decisions without taking them.
    name: 'posture: the repair is applied even when the policy says not to',
    file: 'src/stream.ts',
    edits: [["      if (written !== undefined && this.applies('answer') && slot.chunk !== undefined) {",
      '      if (written !== undefined && slot.chunk !== undefined) {']],
  },
  {
    // `suppress` exists for the degenerate phantom. A suppressing decision that
    // still emits the block is the mode doing nothing while reporting success.
    name: 'posture: a suppressing decision still emits the block',
    file: 'src/stream.ts',
    edits: [["      if (decision === 'suppress' && this.applies('suppress')) slot.chunk = undefined",
      "      if (decision === 'suppress' && this.applies('suppress') && false) slot.chunk = undefined"]],
  },
  {
    // A block that never stated an id is the case the assembler already covers.
    // Repairing it takes credit for core's own fallback and writes an id into a
    // record whose owner never lost one.
    name: 'evidence: a block that never stated an id is repaired rather than left to the assembler',
    file: 'src/stream.ts',
    edits: [["      if (stated === undefined) this.settle(tracked, 'id-never-arrived', 'keep')",
      "      if (stated === undefined) this.settle(tracked, 'empty-id', this.policy.decision)"]],
  },
  {
    // A stream that ends with a block still open is exactly the poisoned shape:
    // the deltas go out, the block assembles from them, and nothing repairs it.
    name: 'finish: a block still open at the end of the stream is never settled',
    file: 'src/stream.ts',
    edits: [['      if (!tracked.held) continue', '      if (tracked.held) continue']],
  },
  {
    // The closing block has the last word — `assemble()` returns it verbatim. A
    // closing block without an identity takes away the id its own deltas stated,
    // and dropping the restoration is what leaves the durable call nameless.
    name: 'evidence: a closing block that lost the id its deltas stated is emitted unchanged',
    file: 'src/stream.ts',
    edits: [['        if (identity(chunk.block.id) === undefined && stated !== undefined) {',
      "        if (identity(chunk.block.id) === undefined && stated === '__never__') {"]],
  },
  {
    // The mirror image: a closing block that *does* carry an identity needs
    // nothing, and repairing it anyway rewrites a call the provider identified.
    name: 'evidence: a closing block that carries an identity is repaired anyway',
    file: 'src/stream.ts',
    edits: [['    if (identity(id) !== undefined) {', "    if (identity(id) === '__never__') {"]],
  },
  {
    // Order is why the buffer exists. Releasing a held block before its identity
    // settles lets a later chunk overtake it — and loses the repair, because the
    // chunk is already on its way to the consumer.
    name: 'order: a held block is released before its identity is settled',
    file: 'src/stream.ts',
    edits: [['    while (this.buffer.length > 0 && this.buffer[0]?.held !== true) {',
      '    while (this.buffer.length > 0) {']],
  },
  {
    // The block a held chunk belongs to must be the one the repair rewrites.
    // Emitting the delta as an ordinary chunk orphans it from `tracked.slots`,
    // so the id the block is settled with never reaches the chunk.
    name: 'order: a delta of a held block is emitted instead of held',
    file: 'src/stream.ts',
    edits: [["        if (!tracked.held) {\n          this.plain(chunk)\n          return\n        }\n        this.hold(tracked, chunk)",
      "        if (!tracked.held) {\n          this.plain(chunk)\n          return\n        }\n        this.plain(chunk)"]],
  },
  {
    // Every chunk the gate has no opinion about has to reach the consumer. A
    // gate that swallows them turns a guard into a filter for the whole stream.
    name: 'pass-through: a chunk the gate has no opinion about is dropped',
    file: 'src/stream.ts',
    edits: [['      default: {\n        this.plain(chunk)\n        return\n      }',
      '      default: {\n        return\n      }']],
  },
  {
    // A settled block is finished. Marking it held again invites the end-of-stream
    // pass to settle it a second time, which double-counts and double-reports it.
    name: 'settle: a settled block stays held, so it is settled again at the end',
    file: 'src/stream.ts',
    edits: [['    tracked.slots = []\n    tracked.held = false', '    tracked.slots = []\n    tracked.held = true']],
  },
  {
    // Fail-open: a failure inside the gate is this plugin's problem, not the
    // consumer's. Throwing it turns a guard bug into a broken model call — a
    // worse failure than the one it repairs.
    name: 'fail-open: a failure inside the gate is thrown to the consumer',
    file: 'src/stream.ts',
    edits: [['      failed = true\n      policy.onFailure?.(error)',
      '      policy.onFailure?.(error)\n      throw error']],
  },
  {
    // What the gate had taken is the authoritative copy once it has failed — the
    // chunks it was holding are the ones the consumer never saw, and abandoning
    // them truncates the stream.
    name: 'fail-open: what the failed gate was holding is dropped rather than released',
    file: 'src/stream.ts',
    edits: [['      for (const emitted of gate.release()) yield emitted',
      '      for (const emitted of []) yield emitted']],
  },
  {
    // The end-of-stream pass is the only thing that settles a block the adapter
    // never closed. Skipping it silently leaves the phantom in the stream.
    name: 'finish: the source ending does not settle the gate',
    file: 'src/stream.ts',
    edits: [['    gate.finish()\n    for (const emitted of gate.drain()) yield emitted',
      '    for (const emitted of gate.drain()) yield emitted']],
  },
  {
    // The listener position *is* the repair: only the outermost `llm/stream`
    // listener sees the stream the consumer (and the assembler) will consume.
    name: 'position: the guard no longer takes the outermost llm/stream boundary',
    file: 'src/index.ts',
    edits: [['  }, { global: true, prepend: true })', '  }, { global: true, prepend: false })']],
  },
  {
    // The stream is dispatched with the registry instance as the listener's
    // `this`, so a mount scoped to a profile stops covering it without `global`.
    name: 'position: the guard stops covering the registry-scoped dispatch',
    file: 'src/index.ts',
    edits: [['  }, { global: true, prepend: true })', '  }, { global: false, prepend: true })']],
  },
  {
    // `observe` exists so an operator can measure before trusting. Making it act
    // removes the only way to see the decisions without taking them.
    name: 'mode: observe applies the repair it exists to measure first',
    file: 'src/index.ts',
    edits: [['      apply: settings.mode !== \'observe\',', '      apply: true,']],
  },
  {
    // `suppress` is the mode that removes the block. Answering instead runs a
    // call the operator asked to have dropped, and the counters say `suppress`.
    name: 'mode: suppress answers instead of removing the call',
    file: 'src/index.ts',
    edits: [["      decision: settings.mode === 'suppress' ? 'suppress' : 'answer',",
      "      decision: 'answer',"]],
  },
  {
    // `off` is the mode that installs nothing. Installing anyway means an
    // operator who turned the guard off still has it rewriting their stream.
    name: 'mode: off installs a listener anyway',
    file: 'src/index.ts',
    // Written through `String` because `settings.mode` is the closed `GuardMode`
    // union: comparing it to a literal outside the union is a compile error, and a
    // mutation that does not compile never reaches the suite.
    edits: [["  if (settings.mode === 'off') {", "  if (String(settings.mode) === '__off__') {"]],
  },
  {
    // Every decision is counted under the verdict that produced it; that is how
    // an operator reads back what the plugin refused to do. Folding them into one
    // bucket hides which rule fired.
    name: 'counters: every verdict is counted as a keep',
    file: 'src/index.ts',
    edits: [['        counters.verdicts[finding.verdict] += 1',
      '        counters.verdicts.keep += 1']],
  },
  {
    // An ordinary tool call is not a decision worth a log line or a history
    // entry — only the ones that needed something are.
    name: 'history: an ordinary tool call is recorded as a decision',
    file: 'src/index.ts',
    edits: [["        if (finding.reason === 'identity-present') return",
      "        if (String(finding.reason) === '__never__') return"]],
  },
  {
    // The history is what an operator reads back after the fact, and the bound is
    // what keeps it from becoming a leak in a long session.
    name: 'history: retained decisions are never trimmed to the configured limit',
    file: 'src/index.ts',
    edits: [['    while (recent.length > settings.historyLimit) recent.shift()',
      '    while (recent.length > 10_000_000) recent.shift()']],
  },
  {
    // The disclosure is the difference between "nothing needed repairing" and
    // "the repair never ran". Emptying it turns a statement into a silent
    // success.
    name: 'report: the blind spots the plugin cannot close are no longer stated',
    file: 'src/index.ts',
    edits: [['    notCovered: blindSpots(),', '    notCovered: [],']],
  },
  {
    // `observe`'s own log line states what the other modes do to the stream
    // instead. A measuring run that logs the acting verb is indistinguishable
    // from an acting one in the log an operator reads afterwards.
    name: 'report: the measuring mode logs the verb of the acting one',
    file: 'src/index.ts',
    edits: [["    case 'empty-id':\n      return mode === 'observe'", "    case 'empty-id':\n      return mode === 'off'"]],
  },
  {
    // The service is how a caller reads the counters. Providing it under another
    // name provides nothing.
    name: 'service: the snapshot service is provided under a name nobody reads',
    file: 'src/index.ts',
    edits: [["\n  ctx.provide(SERVICE, service)\n}",
      "\n  ctx.provide('phantomToolCallGuardValue', service)\n}"]],
  },
  {
    // `off` installs no listener but must still look mounted; a plugin that
    // answered nothing at all is indistinguishable from one that failed to load.
    name: 'mode: off no longer provides the service, so the mount is invisible',
    file: 'src/index.ts',
    edits: [['    ctx.provide(SERVICE, service)\n    return', '    return']],
  },
  {
    // An unrecognised mode must be the one that changes nothing. A typo that
    // repairs is a plugin acting when the operator asked it not to.
    name: 'config: a misspelled mode answers instead of holding back',
    file: 'src/config.ts',
    edits: [["  return 'observe'", "  return 'answer'"]],
  },
  {
    // The absent value is the default; only a *spelling* the plugin does not know
    // is held back. Conflating the two makes an unconfigured mount silently
    // measure instead of repairing.
    name: 'config: an absent mode measures instead of taking the documented default',
    file: 'src/config.ts',
    edits: [['  if (value === undefined) return defaultConfig.mode',
      "  if (value === undefined) return 'observe'"]],
  },
  {
    // Nonnegative integers only: `-1` and `1.5` are typos, not bounds.
    name: 'config: a history limit that is not a nonnegative integer is honoured',
    file: 'src/config.ts',
    edits: [["  return typeof value === 'number' && Number.isInteger(value) && value >= 0\n    ? Math.min(value, ceiling)\n    : fallback",
      "  return typeof value === 'number' ? value : fallback"]],
  },
  {
    // The ceiling is what bounds the retained history when an operator asks for
    // an unbounded one by accident.
    name: 'config: the history limit is no longer bounded by the ceiling',
    file: 'src/config.ts',
    edits: [['    ? Math.min(value, ceiling)', '    ? value']],
  },
  {
    // `report` gates every log line this plugin writes.
    name: 'config: the report flag is forced on regardless of configuration',
    file: 'src/config.ts',
    edits: [['    report: flag(config.report, defaultConfig.report),', '    report: true,']],
  },
]

const argv = process.argv.slice(2)
const filter = argv.find(argument => argument.startsWith('--filter='))?.slice('--filter='.length)

/**
 * Run one command, capturing whether it succeeded.
 *
 * The timeout is not decoration: an arm that removes a reader can leave the
 * suite waiting on something this package would otherwise bound, and a mutant
 * that never terminates is a mutant the suite cannot report on. It is killed
 * here and counted as caught, which is what it is — the suite never reaches its
 * assertions because the code under test never returns.
 */
function run(command, args) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
    return { ok: true, output: '' }
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

/** Emit the compiled artifact the suite actually imports. */
function build() {
  return run(process.execPath, [TSC])
}

/** Run every spec in the suite. */
function test() {
  return run(process.execPath, ['--test', 'test/*.spec.mjs'])
}

const results = []
for (const mutation of MUTATIONS) {
  if (filter !== undefined && !mutation.name.includes(filter)) continue
  // A malformed arm is worse than a missing one: `for (const [from, to] of
  // 'ab')` destructures a *string* into its characters, so the edit becomes a
  // search for two single characters and a rewrite that changes nothing — and
  // the arm then reports SILENT, blaming the suite for a harness bug. Measured
  // in this family: one flat `edits: ['…', '…']` reported "the suite stayed
  // green" while the real mutation was never applied.
  const malformed = mutation.edits.some(edit =>
    !Array.isArray(edit) || edit.length !== 2 || edit.some(part => typeof part !== 'string'))
  if (malformed) {
    results.push({ name: mutation.name, outcome: 'MALFORMED', detail: 'an edit is not a [from, to] pair of strings' })
    continue
  }
  const path = resolve(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  let mutated = original
  let applied = true
  for (const [from, to] of mutation.edits) {
    if (!mutated.includes(from)) {
      applied = false
      break
    }
    mutated = mutated.replace(from, to)
  }
  if (!applied) {
    results.push({ name: mutation.name, outcome: 'NO-OP', detail: 'the source no longer contains the text this arm mutates' })
    continue
  }
  try {
    writeFileSync(path, mutated)
    const built = build()
    if (!built.ok) {
      results.push({ name: mutation.name, outcome: 'TYPEFAIL', detail: 'the mutation does not compile, so the suite never ran' })
      continue
    }
    const tested = test()
    results.push(tested.ok
      ? { name: mutation.name, outcome: 'SILENT', detail: 'the suite stayed green — this arm proves nothing' }
      : { name: mutation.name, outcome: 'CAUGHT', detail: '' })
  } finally {
    writeFileSync(path, original)
  }
}

// Put `lib/` back. The last arm left its mutation COMPILED there — the source is
// restored in the `finally` above, but the build output is not, and a checkout
// that runs this script and then publishes would ship the last mutant. Rebuilt
// once here so the tree is consistent whether a human runs this or CI does.
const restored = build()
if (!restored.ok) {
  process.stdout.write('\nWARNING: the rebuild after restoring the sources failed — lib/ may hold a mutant\n')
}

const caught = results.filter(result => result.outcome === 'CAUGHT').length
const declared = new Set(MUTATIONS.filter(mutation => mutation.equivalent !== undefined).map(mutation => mutation.name))
const equivalents = results.filter(result => result.outcome === 'SILENT' && declared.has(result.name))
const silent = results.filter(result => result.outcome === 'SILENT' && !declared.has(result.name))
const other = results.filter(result => result.outcome !== 'CAUGHT' && result.outcome !== 'SILENT')

for (const result of results) {
  const label = result.outcome === 'SILENT' && declared.has(result.name) ? 'EQUIVALENT' : result.outcome
  process.stdout.write(`${label.padEnd(10)} ${result.name}${result.detail === '' ? '' : `\n           ${result.detail}`}\n`)
}
process.stdout.write(`\n${caught}/${results.length} caught`)
process.stdout.write(silent.length === 0
  ? ` — no arm is silent (${equivalents.length} declared equivalent — see the arms)\n`
  : `, ${silent.length} SILENT\n`)
if (other.length > 0) {
  process.stdout.write(`${other.length} arm(s) could not be evaluated: ${other.map(result => `${result.outcome} ${result.name}`).join(', ')}\n`)
}
process.exitCode = silent.length === 0 && other.length === 0 ? 0 : 1
