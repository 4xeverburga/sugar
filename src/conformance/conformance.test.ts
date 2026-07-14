import { describe, expect, it } from 'vitest'
import { registry } from '../registry/index.js'
import {
  checkDeterminism,
  checkFiniteNumbers,
  checkFlowConservation,
  checkSchemaRoundTrip,
  checkSourcedFormulas,
  makeConformanceCtx,
} from './checks.js'

function fixtureConfigByModelId(modelId: string): unknown {
  if (modelId === 'queue') return { kind: 'queue' }
  if (modelId === 'client_pool') return { kind: 'host', profile: 'client_pool', requestRatePerSec: 100 }
  if (modelId === 'external_api') return { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 50 }
  return {
    kind: 'host',
    profile: 'transactional_api',
    configMode: 'manual',
    manualBaselineLatencyMs: 10,
    manualSaturationRPS: 500,
    manualMaxRPS: 550,
    overloadBehavior: 'clamp',
    minReplicas: 1,
    maxReplicas: 3,
    bootDelayMs: 8000,
    highWatermark: 0.8,
    lowWatermark: 0.3,
  }
}

describe('conformance suite', () => {
  it('gates each registered model on deterministic finite flow and schema checks', () => {
    for (const model of registry.byKind.values()) {
      const config = fixtureConfigByModelId(model.id)
      const validated = model.validateConfig(config)
      expect(validated.ok).toBe(true)
      if (!validated.ok) continue
      const ctx = makeConformanceCtx(model, validated.value)
      checkDeterminism(model, ctx)
      const result = model.computeWindow(ctx)
      checkFiniteNumbers(model, result)
      checkFlowConservation(model, ctx, result)
      checkSourcedFormulas(model)
      checkSchemaRoundTrip(model, validated.value)
    }
  })
})
