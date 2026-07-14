import { describe, expect, it } from 'vitest'
import type { NodeModel } from '../../src/registry/nodeModel.js'
import {
  checkDeterminism,
  checkFiniteNumbers,
  makeConformanceCtx,
} from '../../src/conformance/checks.js'

describe('conformance negative fixtures', () => {
  it('flags non-deterministic model failures with model id in message', () => {
    let counter = 0
    const nondeterministicModel: NodeModel<{ kind: 'queue' }, null> = {
      id: 'fixture_nondeterministic',
      label: 'Fixture NonDeterministic',
      paramSchema: { params: [] },
      formulaDescriptors: [],
      validateConfig(raw) {
        return raw && typeof raw === 'object' && (raw as { kind?: string }).kind === 'queue'
          ? { ok: true, value: raw as { kind: 'queue' } }
          : { ok: false, message: 'invalid' }
      },
      initialState() {
        return null
      },
      reconcileState() {
        return null
      },
      acceptCapacityRPS() {
        return Number.POSITIVE_INFINITY
      },
      computeWindow() {
        counter += 1
        return {
          metrics: { throughputPerSec: counter, queueDepth: 0 },
          nextState: null,
          edgeOutputRPS: new Map<string, number>(),
        }
      },
    }

    const ctx = makeConformanceCtx(nondeterministicModel, { kind: 'queue' })
    expect(() => checkDeterminism(nondeterministicModel, ctx)).toThrow(/determinism violation: fixture_nondeterministic/i)
  })

  it('flags NaN-producing model failures with model id in message', () => {
    const nanModel: NodeModel<{ kind: 'queue' }, null> = {
      id: 'fixture_nan',
      label: 'Fixture NaN',
      paramSchema: { params: [] },
      formulaDescriptors: [],
      validateConfig(raw) {
        return raw && typeof raw === 'object' && (raw as { kind?: string }).kind === 'queue'
          ? { ok: true, value: raw as { kind: 'queue' } }
          : { ok: false, message: 'invalid' }
      },
      initialState() {
        return null
      },
      reconcileState() {
        return null
      },
      acceptCapacityRPS() {
        return Number.POSITIVE_INFINITY
      },
      computeWindow() {
        return {
          metrics: { throughputPerSec: Number.NaN, queueDepth: 0 },
          nextState: null,
          edgeOutputRPS: new Map<string, number>(),
        }
      },
    }

    const ctx = makeConformanceCtx(nanModel, { kind: 'queue' })
    const result = nanModel.computeWindow(ctx)
    expect(() => checkFiniteNumbers(nanModel, result)).toThrow(/finite violation: fixture_nan/i)
  })
})
