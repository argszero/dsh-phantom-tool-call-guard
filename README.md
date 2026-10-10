# @argszero/dsh-phantom-tool-call-guard

Fixes a session that is dead from one sequence number onward, failing every turn
with

```
format v4 tool/result at seq N requires toolCallId matching its tool source
```

for a tool call the model advertised with **no identity at all** — an empty `id`
and an empty `name` at the tail of a turn.

One report, one mechanism, one seam:
[#9215](https://github.com/deepseek-ai/deepseek-harness/discussions/9215) —
*"an empty-identity phantom tool call is written, its result can never validate,
and the session never recovers"*.

## The problem

The call is not the mystery. The harness's own assembler decides the identity of
every tool-call block:

```
packages/llm/llm/src/assembler.ts
  id: partial.toolCallId ?? brandString<ToolCallId>(`call-${index}`)
```

That fallback is **nullish**. An adapter that emits an empty string — not a
missing field — defeats it, and the block assembles with `id: ''`.

From there the failure is an asymmetry at the durable write boundary:

| half of the transaction | what the V4 codec does | result |
|---|---|---|
| `tool/call` | **no check at all** on `callId` | `callId: ""` is admitted and lands |
| `tool/result` | requires `toolCallId` nonempty **and** equal to its source `callId` | refused, always |

And the refusal happens while the encoder is still building the row — *before*
the append commits. So nothing is written for that step, the dangling `tool/call`
remains the last word of the log, and the next turn recomputes the identical
result from the identical seq:

```
packages/core/agent-loop  appendToolCall(block)      → tool/call  callId:""   LANDED
                          appendToolResult(...)      → encode → assertV4ToolResultMessage
                                                                  └─ throw "requires toolCallId
                                                                     matching its tool source"
                                                     ← nothing appended, seq unchanged
        ↓ next turn
                          resumes from the same seq, recomputes, throws again — forever
```

The session is not slow, or confused, or waiting on a retry budget. It is
**permanently stuck at that sequence number**, and the write path cannot be
reached from a plugin: it is core's.

## What this plugin does

It repairs the identity on the **response side of the `llm/stream` waterfall** —
the one seam that reaches both halves of the problem at once.

```ts
// packages/llm/llm/src/index.ts — the waterfall's return value is a value
ctx.on('llm/stream', (options, next) => { … return wrapped }, { prepend: true })
```

The loop consumes exactly that value:

```ts
// packages/core/agent-loop/src/agent.ts
for await (const chunk of stream) { … }
```

and feeds one `AssistantStreamAttempt` that *both* assembles the durable
`assistant/message` and records the raw chunks for replay. A chunk repaired here
is therefore repaired in the message **and** in the record it will be replayed
from, and the two cannot disagree afterwards. The request side of the same
waterfall is read-only — a loop-built request arrives deep-frozen — but the
returned stream is a value a listener may replace. The listener registers with
`prepend: true` because a waterfall's position is part of its meaning: the repair
has to be the last transformation before the consumer, not one an outer layer can
undo.

The gate judges each tool-call block by the same rule the assembler does, which
is why it reads the two halves of a block differently:

| evidence | the assembler will… | verdict |
|---|---|---|
| `block-end.block.id` present | use it verbatim (a closing block is authoritative) | keep, `identity-present` |
| `block-end.block.id` **empty or absent** | write `id: ''` — **this is the poison** | **answer**: write `call-phantom-<index>` |
| last delta's `id` is `''` | write `id: ''` — **this is the poison** | **answer**: write `call-phantom-<index>` |
| last delta's `id` is `undefined` | fall back to `call-<index>` | keep, `id-never-arrived` |
| deltas stated an id, `block-end` arrived without one | lose the id the deltas stated | **answer**: restore it, `id-lost-at-close` |

The distinction in the last two rows is the point. The harness already covers a
*missing* id; only an **empty** one poisons, and an id the closing block dropped
after the deltas stated it would take away an identity the stream had already
given. So the gate acts in exactly the place the harness's own guard is defeated
— and nowhere else.

What is written is namespaced on purpose: `call-phantom-<index>`. A reader who
finds it in a log can tell at a glance that the provider did not write it. This
plugin puts a value into a durable record, and a value that looks like the
provider's own would be a lie about provenance.

## Install

```sh
npm install @argszero/dsh-phantom-tool-call-guard@0.1.1
```

Then mount it. The package ships a bundle patch
(`dsh.bundle.patch: ./cordis.patch.yml`), so a deployment that follows the
harness's bundle convention gets it by adding one entry:

```yaml
- insert:
    - id: phantom-tool-call-guard
      name: '@argszero/dsh-phantom-tool-call-guard'
```

Mounting it directly works the same way and takes the same config:

```ts
import guard from '@argszero/dsh-phantom-tool-call-guard'

ctx.plugin(guard, { mode: 'observe' })   // measure before you repair
```

## Measuring before repairing

`mode: 'observe'` runs the same analysis, counts what it *would* write, and
emits the stream unchanged. It answers the question the counters otherwise answer
by assumption — *"is this happening in my deployment"* — and it is meant to be
run first.

```ts
const guard = ctx.get('phantomToolCallGuard')
guard.snapshot()
```

```jsonc
{
  "mode": "observe",
  "settings": { "mode": "observe", "report": true, "historyLimit": 20 },
  "counters": {
    "streams": 41, "errors": 0,
    "verdicts": { "keep": 38, "answer": 3, "suppress": 0 },
    "reasons": {
      "identity-present": 35, "empty-id": 3,
      "id-lost-at-close": 0, "id-never-arrived": 0
    }
  },
  "recent": [
    {
      "provider": "deepseek-official", "model": "deepseek-chat",
      "sessionId": "…", "index": 2,
      "verdict": "answer", "reason": "empty-id",
      "written": "call-phantom-2", "name": undefined
    }
  ],
  "notCovered": [ "…" ]
}
```

`recent` is the whole diagnosis: which route produced the call, which block index
it was, and the evidence the decision rested on. `notCovered` is not decoration —
a guard that reports only its decisions leaves an operator unable to tell
*"nothing needed repairing"* from *"the repair never ran"*, and those two look
identical in a log.

`guard.reset()` zeroes the counters and drops the retained history.

## Configuration

| option | default | meaning |
|---|---|---|
| `mode` | `'answer'` | `answer` supplies the missing id so the call becomes answerable; `suppress` drops the block instead; `observe` counts the same decisions and emits the stream unchanged; `off` installs no listener at all |
| `report` | `true` | log one line per decision, with the verb the mode earns (`would write` / `wrote` / `dropped`) |
| `historyLimit` | `20` | how many recent decisions `snapshot()` keeps (`0`…`512`); `0` keeps none while still counting |

`answer` is the default because it is the smallest change that makes the session
survive — and because the alternative deletes. `suppress` is the posture the
harness already takes for tool calls it cannot execute safely (max-token
truncation), and deleting is only correct when the block is certainly not a
request. That is true of the degenerate phantom (empty id, empty name, `{}`
arguments) and **false** for the second reading of the same symptom: an adapter
that lost the id of a call that is real in every other respect. There,
`suppress` silently discards a tool the model asked for, and `answer` runs it.
So the preserving default is the acting one, and the destructive one is one
config line away.

An **unrecognised** `mode` spelling resolves to `observe`, not `answer`: the
failure mode of a typo has to be the one that changes nothing. `off` still
provides the service, because a mount that answered nothing would be
indistinguishable from a plugin that failed to load.

## Where it attaches

`llm/stream` is a documented waterfall, and a waterfall's *position* is part of
its meaning here. The guard registers with `{ global: true, prepend: true }` —
`prepend` puts it outside every default listener so the repair is the last
transformation the consumer sees, and `global` is because the stream is
dispatched with the registry instance as the listener's `this`, so a mount scoped
to a profile must still cover it.

```
llm/stream waterfall — the return value is the chunk stream
├── phantom-tool-call-guard        ← this plugin (prepend): repairs the returned stream
│   └── (a listener mounted after it with `prepend` sits OUTSIDE it — see below)
├── …other listeners…
└── the adapter's stream

        ↓ the loop consumes exactly this value
agent-loop: AssistantStreamAttempt
   ├── assemble() → the durable assistant/message      ← sees the id written here
   └── raw chunks → the durable replay record           ← and the same id here
```

Holding is bounded and order is preserved. A block is held *only* while its
identity is unsettled, which in the shipped adapters is at most one chunk: the
first `tool-call-delta` normally carries the id. Everything that arrives behind a
held block waits in the same buffer, so a held block can never be overtaken — no
chunk is re-ordered and no index is renumbered, because `BlockAssembler` keys
blocks by index and records their order at first sight.

`inject = ['llm']` makes the LLM service a hard requirement: the seam is a chunk
stream, so a composition with no models has nothing for this guard to guard, and
a mount that silently listened to nothing would be indistinguishable from one
that failed to load.

## Honest boundaries

- **It is preventive, not curative.** A session whose `tool/call` already landed
  with an empty id cannot be repaired from here, and this plugin does not try:
  the refusal happens at the write boundary, before the append, and fixing a log
  that already contains a dangling call needs core. If you are reading this
  because a session is already stuck, this package is the fix for the *next*
  attempt, not a rescue for that one.
- **It repairs identity and nothing else.** An empty tool *name* is left exactly
  as the model produced it. Inventing a name would dispatch a tool the model never
  asked for, while a nameless call fails honestly at the registry and its durable
  `tool/result` closes the transaction either way.
- **It covers layers mounted below it.** A listener registered with `prepend`
  *after* this plugin mounts sits outside it, and this guard repairs a stream that
  layer has not yet seen. In a deployment with several stream rewrites, mount this
  one last. The suite pins both directions.
- **`observe` applies nothing.** It decides, counts and reports exactly as
  `answer` would, so the two runs differ in nothing but the emitted stream.
- **An abandoned stream releases nothing.** If the consumer breaks out of the
  loop — an abort, an interrupt — the chunks of a block still held are dropped
  with it. That is safe, because the harness discards the tool calls of an
  interrupted attempt, and it means an interrupted turn neither needs nor gets a
  repair.
- **The minted id is unique per block, not per session.** `call-phantom-<index>`
  is unique within a stream. Two *attempts* in one session can mint the same id,
  which is harmless unless the earlier attempt's `tool/result` never landed — in
  which case the id stays advertised-unsettled and only a whole-log relationship
  check would notice.
- **It fails open.** If the gate throws on a stream, that stream's remaining
  chunks are passed through unchanged, counted under `errors`, and logged once. A
  guard whose bug broke working model calls would be a worse failure than the one
  it repairs.

## Compatibility

The plugin wraps a documented event's return value and reads two public type
surfaces, so what it depends on is the shape of `StreamChunk` and the waterfall's
dispatch signature. Peer ranges name the lines that were verified by pinning
every harness package to one line and running the suite against it
(`npm run test:probe-lines`), never inferred:

| peer | range |
|---|---|
| `@deepseek-ai/dsh-llm` | `>=0.1.7-rc.2 <0.2.0 \|\| >=0.2.0-rc.2 <0.2.1` |
| `@deepseek-ai/cordis` | `^4.0.2` |

Verified against the `0.1.7-rc.2` and `0.2.0-rc.2` lines. Each `||` segment's
floor is the build that was actually run, so the range and the probed set are the
same set — a line this plugin has not been run on is a line it does not claim.
The ceiling is the next line rather than the next major, because `StreamChunk` is
a union this gate switches on and a line it has not been run against is not a
line it claims to speak.

`@deepseek-ai/dsh-llm` is a peer for the type contract, not for a runtime: the
plugin carries `import type { StreamChunk, ToolCallId } from '@deepseek-ai/dsh-llm'`
and `import type {} from '@deepseek-ai/dsh-llm'` for declaration merging, which is
how `ctx.on('llm/stream', …)` is typed at all.

**No runtime dependency, at all.** The plugin never imports a harness package for
value — it subscribes to an event the harness dispatches and returns a wrapper
around the stream it was handed. Declaring the runtime as a dependency would be a
dependency the artifact does not have, and in a `profile` deployment a plugin's
own dependency can materialize a second copy of a harness package, which is a
failure this repository has already shipped more than once. The packaging suite
asserts this on the **emitted** JavaScript, not on the sources: `lib/` must reach
nothing but its own modules.

## Tests

```sh
npm test                   # the full suite, against a real cordis context and a real LlmRuntime
npm run test:inject        # mutate the source one rule at a time; every arm must be caught
npm run test:probe-lines   # pin every harness package to one line and re-run the suite
```

The integration suite does not simulate the seam. It builds a real Cordis
context, mounts a real `LlmRuntime` with a real adapter, and drives a real chunk
stream through the **real** `llm/stream` waterfall. The control arm runs the same
sequence with the plugin absent and watches the durable result fail to validate
(`requires toolCallId matching its tool source`); the guarded arm's call carries
an id and is answerable. A second pair swaps the mount order to prove the
listener position is real rather than asserted:

```
plugin mounted with prepend : the block the loop assembles carries an id
plugin mounted without it   : the block behind it does not — the repair is outside
```

## License

MIT
