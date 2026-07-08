import { describe, expect, it } from 'vitest'
import {
  buildEdgeCongestionDescriptor,
  buildEdgeConnectionsDescriptor,
  buildEdgeRateDescriptor,
  buildHostCapacityDescriptor,
  buildHostCollapseDescriptor,
  buildHostLatencyDescriptor,
  buildHostReplicaEvictionDescriptor,
  buildHostSaturationDescriptor,
  buildHostShedDescriptor,
  buildQueueBacklogDescriptor,
  buildReplicaDivisionDescriptor,
  buildScalingPolicyDescriptor,
  validateFormulaDescriptorsHaveSources,
} from '../src/formulaCatalog'

describe('formula catalog — every descriptor has >=1 source (SC-005)', () => {
  it('host descriptors all carry sources', () => {
    const descriptors = [
      buildHostSaturationDescriptor({ incomingRPS: 100, capacityRPS: 500, saturationRatio: 0.2 }),
      buildHostLatencyDescriptor({ baseLatencyMs: 10, saturationRatio: 0.2, latencyMs: 12.5 }),
      buildHostCapacityDescriptor({ maxWorkerThreads: 8, cpuProcessingTimeMs: 16, capacityRPS: 500 }),
      buildHostShedDescriptor({ incomingRPS: 700, manualMaxRPS: 550, shedRPS: 150 }),
      buildReplicaDivisionDescriptor({ incomingRPS: 400, effectiveCount: 4, perReplicaRPS: 100 }),
      buildScalingPolicyDescriptor({
        perReplicaSaturation: 0.9,
        highWatermark: 0.8,
        lowWatermark: 0.3,
        nominalCount: 2,
        minReplicas: 1,
        maxReplicas: 4,
      }),
    ]
    expect(() => validateFormulaDescriptorsHaveSources(descriptors)).not.toThrow()
    for (const descriptor of descriptors) expect(descriptor.sources.length).toBeGreaterThan(0)
  })

  it('edge and queue descriptors all carry sources', () => {
    const descriptors = [
      buildEdgeRateDescriptor({ currentRPS: 100, averagePayloadSizeKB: 10, currentMBps: 0.9765625 }),
      buildEdgeConnectionsDescriptor({ currentRPS: 100, latencySec: 0.05, activeConnections: 5 }),
      buildEdgeCongestionDescriptor({ targetSaturationRatio: 0.9, isCongested: true }),
      buildQueueBacklogDescriptor({ inflowMBps: 20, outflowMBps: 10, backlogGB: 0.6 }),
    ]
    expect(() => validateFormulaDescriptorsHaveSources(descriptors)).not.toThrow()
    for (const descriptor of descriptors) expect(descriptor.sources.length).toBeGreaterThan(0)
  })

  it('throws when a descriptor has zero sources', () => {
    expect(() =>
      validateFormulaDescriptorsHaveSources([
        { id: 'bad', name: 'bad', expression: 'x', inputs: {}, sources: [], isBinding: false },
      ]),
    ).toThrow('bad')
  })
})

describe('formula catalog — inputs mirror the live computation at a known operating point', () => {
  it('saturation descriptor reports the exact incoming/capacity/binding used to compute it', () => {
    const descriptor = buildHostSaturationDescriptor({ incomingRPS: 460, capacityRPS: 500, saturationRatio: 0.92 })
    expect(descriptor.inputs.incomingRPS).toBe(460)
    expect(descriptor.inputs.capacityRPS).toBe(500)
    expect(descriptor.isBinding).toBe(true) // 0.92 >= HOST_SATURATION_THRESHOLD (0.85)
  })

  it('latency descriptor reports the exact base/rho used to compute it', () => {
    const descriptor = buildHostLatencyDescriptor({ baseLatencyMs: 10, saturationRatio: 0.2, latencyMs: 12.5 })
    expect(descriptor.inputs.baseLatencyMs).toBe(10)
    expect(descriptor.inputs.saturationRatio).toBe(0.2)
    expect(descriptor.isBinding).toBe(false)
  })

  it('shed descriptor is binding exactly when shedRPS > 0', () => {
    expect(buildHostShedDescriptor({ incomingRPS: 400, manualMaxRPS: 550, shedRPS: 0 }).isBinding).toBe(false)
    expect(buildHostShedDescriptor({ incomingRPS: 700, manualMaxRPS: 550, shedRPS: 150 }).isBinding).toBe(true)
  })

  it('edge rate descriptor reports the exact RPS/payload/MBps used to compute it', () => {
    const descriptor = buildEdgeRateDescriptor({ currentRPS: 200, averagePayloadSizeKB: 50, currentMBps: 9.765625 })
    expect(descriptor.inputs.currentRPS).toBe(200)
    expect(descriptor.inputs.averagePayloadSizeKB).toBe(50)
    expect(descriptor.inputs.currentMBps).toBeCloseTo(9.765625, 5)
  })

  it("connections descriptor (Little's law) reports the exact rate/latency/result", () => {
    const descriptor = buildEdgeConnectionsDescriptor({ currentRPS: 200, latencySec: 0.25, activeConnections: 50 })
    expect(descriptor.inputs.currentRPS).toBe(200)
    expect(descriptor.inputs.latencySec).toBe(0.25)
    expect(descriptor.inputs.activeConnections).toBe(50)
  })

  it('queue backlog descriptor is binding exactly when inflow exceeds outflow', () => {
    expect(buildQueueBacklogDescriptor({ inflowMBps: 20, outflowMBps: 10, backlogGB: 0.6 }).isBinding).toBe(true)
    expect(buildQueueBacklogDescriptor({ inflowMBps: 5, outflowMBps: 10, backlogGB: 0 }).isBinding).toBe(false)
  })

  it('replica-division descriptor reports the exact incoming/effectiveCount/perReplica used to compute it (feature 013)', () => {
    const descriptor = buildReplicaDivisionDescriptor({ incomingRPS: 400, effectiveCount: 4, perReplicaRPS: 100 })
    expect(descriptor.inputs.incomingRPS).toBe(400)
    expect(descriptor.inputs.effectiveCount).toBe(4)
    expect(descriptor.inputs.perReplicaRPS).toBe(100)
    expect(descriptor.isBinding).toBe(false)
    expect(descriptor.sources.length).toBeGreaterThan(0)
  })

  it('scaling-policy descriptor is binding exactly when saturation is outside the hysteresis band (feature 013)', () => {
    const inBand = buildScalingPolicyDescriptor({
      perReplicaSaturation: 0.5,
      highWatermark: 0.8,
      lowWatermark: 0.3,
      nominalCount: 2,
      minReplicas: 1,
      maxReplicas: 4,
    })
    expect(inBand.isBinding).toBe(false)
    const aboveHigh = buildScalingPolicyDescriptor({
      perReplicaSaturation: 0.9,
      highWatermark: 0.8,
      lowWatermark: 0.3,
      nominalCount: 2,
      minReplicas: 1,
      maxReplicas: 4,
    })
    expect(aboveHigh.isBinding).toBe(true)
    expect(aboveHigh.sources.length).toBeGreaterThan(0)
  })
})

// Feature 012 (Overload Collapse), US4 (T017).
describe('buildHostCollapseDescriptor (research.md D2/D7)', () => {
  it('carries at least one literature source citation (SC-005/constitution II)', () => {
    const descriptor = buildHostCollapseDescriptor({ incomingRPS: 1500, kneeRPS: 500, overloadRatio: 3, forwardedRPS: 500 / 9 })
    expect(descriptor.sources.length).toBeGreaterThan(0)
  })

  it('is binding once incomingRPS exceeds kneeRPS, not below it', () => {
    const belowKnee = buildHostCollapseDescriptor({ incomingRPS: 300, kneeRPS: 500, overloadRatio: 0.6, forwardedRPS: 300 })
    expect(belowKnee.isBinding).toBe(false)
    const pastKnee = buildHostCollapseDescriptor({ incomingRPS: 1500, kneeRPS: 500, overloadRatio: 3, forwardedRPS: 500 / 9 })
    expect(pastKnee.isBinding).toBe(true)
  })

  it('reports the exact live incomingRPS/kneeRPS/overloadRatio/forwardedRPS used to compute it', () => {
    const descriptor = buildHostCollapseDescriptor({ incomingRPS: 1650, kneeRPS: 550, overloadRatio: 3, forwardedRPS: 550 / 9 })
    expect(descriptor.inputs.incomingRPS).toBe(1650)
    expect(descriptor.inputs.kneeRPS).toBe(550)
    expect(descriptor.inputs.overloadRatio).toBe(3)
    expect(descriptor.inputs.forwardedRPS).toBeCloseTo(550 / 9, 10)
  })
})

// 012-overload-collapse refinement (research.md D9): the replica-eviction
// descriptor shown for elastic (scaling-group) collapse-mode hosts instead
// of buildHostCollapseDescriptor above.
describe('buildHostReplicaEvictionDescriptor (research.md D9)', () => {
  it('carries at least one literature source citation (SC-005/constitution II)', () => {
    const descriptor = buildHostReplicaEvictionDescriptor({ perReplicaSaturation: 2, effectiveReplicas: 4, evictedReplicas: 2 })
    expect(descriptor.sources.length).toBeGreaterThan(0)
  })

  it('is binding once per-replica saturation exceeds 1, not at or below it', () => {
    const atCapacity = buildHostReplicaEvictionDescriptor({ perReplicaSaturation: 1, effectiveReplicas: 4, evictedReplicas: 0 })
    expect(atCapacity.isBinding).toBe(false)
    const overCapacity = buildHostReplicaEvictionDescriptor({ perReplicaSaturation: 1.5, effectiveReplicas: 4, evictedReplicas: 1 })
    expect(overCapacity.isBinding).toBe(true)
  })

  it('reports the exact live perReplicaSaturation/effectiveReplicas/evictedReplicas used to compute it', () => {
    const descriptor = buildHostReplicaEvictionDescriptor({ perReplicaSaturation: 4, effectiveReplicas: 4, evictedReplicas: 3 })
    expect(descriptor.inputs.perReplicaSaturation).toBe(4)
    expect(descriptor.inputs.effectiveReplicas).toBe(4)
    expect(descriptor.inputs.evictedReplicas).toBe(3)
  })
})

