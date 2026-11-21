/**
 * Configuration: a knob is only a knob if a wrong value resolves to something
 * safe, and the two rules that matter are which way a typo falls and which value
 * an absent setting takes.
 *
 * @module test/config.spec
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { defaultConfig, normalizeConfig } from '../lib/config.js'

describe('normalizeConfig', () => {
  it('resolves every default from an empty configuration', () => {
    assert.deepEqual(normalizeConfig({}), { mode: 'answer', unnamed: 'suppress', report: true, historyLimit: 20 })
    assert.deepEqual(defaultConfig, { mode: 'answer', unnamed: 'suppress', report: true, historyLimit: 20 })
  })

  it('keeps the two spellings it implements for an unnamed call', () => {
    assert.equal(normalizeConfig({ unnamed: 'suppress' }).unnamed, 'suppress')
    assert.equal(normalizeConfig({ unnamed: 'keep' }).unnamed, 'keep')
  })

  it('withholds by default, and leaves the block alone for a spelling it does not implement', () => {
    // Absent takes the acting default; a typo takes the one that changes nothing,
    // because a setting nobody wrote correctly must never be the reason a block
    // the model asked for disappears from the stream.
    assert.equal(normalizeConfig({}).unnamed, 'suppress')
    assert.equal(normalizeConfig({ unnamed: 'drop' }).unnamed, 'keep')
    assert.equal(normalizeConfig({ unnamed: '' }).unnamed, 'keep')
  })

  it('keeps every mode it implements', () => {
    for (const mode of ['answer', 'suppress', 'observe', 'off']) {
      assert.equal(normalizeConfig({ mode }).mode, mode)
    }
  })

  it('falls back to measuring for a mode it does not implement', () => {
    // A misspelled mode must be the one that changes nothing: a plugin acting
    // when the operator asked it not to is worse than one that does nothing.
    assert.equal(normalizeConfig({ mode: 'repair' }).mode, 'observe')
    assert.equal(normalizeConfig({ mode: '' }).mode, 'observe')
  })

  it('takes the documented default for an absent mode', () => {
    assert.equal(normalizeConfig({}).mode, 'answer')
  })

  it('accepts only a nonnegative integer history limit', () => {
    assert.equal(normalizeConfig({ historyLimit: 0 }).historyLimit, 0)
    assert.equal(normalizeConfig({ historyLimit: 5 }).historyLimit, 5)
    assert.equal(normalizeConfig({ historyLimit: -1 }).historyLimit, 20)
    assert.equal(normalizeConfig({ historyLimit: 1.5 }).historyLimit, 20)
    assert.equal(normalizeConfig({ historyLimit: Number.NaN }).historyLimit, 20)
  })

  it('bounds the history an operator asks for by accident', () => {
    assert.equal(normalizeConfig({ historyLimit: 10_000 }).historyLimit, 512)
  })

  it('reads only a boolean for the report flag', () => {
    assert.equal(normalizeConfig({ report: false }).report, false)
    assert.equal(normalizeConfig({ report: true }).report, true)
    assert.equal(normalizeConfig({ report: 'yes' }).report, true)
  })
})
