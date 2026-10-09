/**
 * Configuration, normalized once at mount.
 *
 * The knobs are the three questions an operator actually asks about a plugin
 * that rewrites a model's output stream: *which repair do you want* (`mode`),
 * *what did you do* (`report`), and *how much of that can I read back*
 * (`historyLimit`).
 *
 * @module @argszero/dsh-phantom-tool-call-guard/config
 */

/**
 * What the plugin does with a tool-call block whose identity is empty.
 *
 * - `answer` supplies the missing id, so the call is awarded the one thing it
 *   lacks and the harness can answer it. The block is preserved; the call is
 *   dispatched, fails as an unknown tool if the name is empty too, and a
 *   `tool/result` lands against it. This is the default because it is the
 *   smallest change that makes the session survive, and because a call whose id
 *   an adapter dropped may well be a real call: `answer` runs it.
 * - `suppress` drops the block, the posture the harness already takes for tool
 *   calls it cannot execute safely (max-token truncation).
 * - `observe` decides and counts exactly as it would, and changes nothing.
 * - `off` installs no listener at all.
 */
export type GuardMode = 'answer' | 'suppress' | 'observe' | 'off'

/** The plugin configuration as a user writes it. */
export interface Config {
  /** Which repair to apply to a tool-call block whose identity is empty. */
  readonly mode?: GuardMode
  /** Log one line per decision at `info`. */
  readonly report?: boolean
  /** How many recent decisions `snapshot()` keeps. `0` keeps none. */
  readonly historyLimit?: number
}

/** The configuration with every default resolved. */
export interface Settings {
  readonly mode: GuardMode
  readonly report: boolean
  readonly historyLimit: number
}

/**
 * The reference defaults, also the fallbacks used per field.
 *
 * A plain object rather than a schema: every value is a primitive, and a plugin
 * that failed to mount because a configuration library disagreed about the
 * spelling of `observe` would be a worse trade than one that reads what it was
 * given.
 *
 * `answer` is the default. The alternative, `suppress`, deletes the block, and
 * deleting is only correct when the block is certainly not a request — which is
 * true of the degenerate phantom this plugin was written for (empty id, empty
 * name, `{}` arguments) and *false* for the second reading of the same symptom:
 * an adapter that lost the id of a call that is real in every other respect. In
 * that second reading `answer` runs the tool the model asked for and `suppress`
 * silently discards it, so the acting default is the one that preserves the
 * call, and the destructive one is one config line away.
 *
 * An **unrecognised** `mode` resolves to `observe` rather than to `answer`: the
 * failure mode of a typo has to be the one that changes nothing, and that rule
 * is about the spelling, not about the absent value (which takes the default).
 */
export const defaultConfig: Required<Config> = {
  mode: 'answer',
  report: true,
  historyLimit: 20,
}

/** Read a bounded non-negative integer, falling back for anything else. */
function count(value: number | undefined, fallback: number, ceiling: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? Math.min(value, ceiling)
    : fallback
}

/** Read a boolean, falling back for anything else. */
function flag(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Resolve a `mode`, keeping only the four spellings this plugin implements.
 * @param value - the configured mode, if any.
 * @returns the configured mode, the default when absent, or `observe` for anything unrecognised.
 */
function mode(value: GuardMode | undefined): GuardMode {
  if (value === undefined) return defaultConfig.mode
  if (value === 'answer' || value === 'suppress' || value === 'observe' || value === 'off') return value
  return 'observe'
}

/**
 * Resolve a user configuration into the settings the plugin runs with.
 * @param config - the configuration as mounted, possibly empty.
 * @returns every setting, with defaults applied.
 */
export function normalizeConfig(config: Config): Settings {
  return {
    mode: mode(config.mode),
    report: flag(config.report, defaultConfig.report),
    historyLimit: count(config.historyLimit, defaultConfig.historyLimit, 512),
  }
}
