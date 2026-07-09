// Formula descriptor builders for the host/queue/edge model (research.md
// D8, constitution Principle II — every emitted metric ships a sourced,
// named formula). Reuses the FormulaDescriptor shape unchanged from 009.

import type { FormulaDescriptor, FormulaSource } from './ports.js'
import { EDGE_CONGESTION_THRESHOLD, HOST_RHO_CLAMP, HOST_SATURATION_THRESHOLD } from './config.js'

const SOURCE_KLEINROCK: FormulaSource = {
  title: 'Kleinrock, Queueing Systems Vol. 1 (1975)',
  url: 'https://www.wiley.com/en-us/Queueing+Systems%2C+Volume+1%3A+Theory-p-9780471491101',
  note: 'M/M/1 utilization (ρ) and residence-time scaling by 1/(1-ρ).',
}

const SOURCE_HARCHOL_BALTER: FormulaSource = {
  title: 'Harchol-Balter, Performance Modeling and Design of Computer Systems (2013)',
  url: 'https://www.cs.cmu.edu/~harchol/Perfbook/book.html',
  note: 'The "hockey stick" latency-under-load framing used here.',
}

const SOURCE_LITTLE: FormulaSource = {
  title: 'Little, A Proof for the Queuing Formula L = λW (1961)',
  url: 'https://www.jstor.org/stable/167570',
  note: "Little's law: mean concurrent count = arrival rate × mean time in system.",
}

const SOURCE_DENNING_BUZEN: FormulaSource = {
  title: 'Denning & Buzen, The Operational Analysis of Queueing Network Models (1978)',
  url: 'https://dl.acm.org/doi/10.1145/356698.356701',
  note: 'Utilization law: capacity from service demand and server count.',
}

const SOURCE_PRODUCT_DATA_MODEL: FormulaSource = {
  title: 'SUGAR data model (011-host-queue-model)',
  url: '/specs/011-host-queue-model/data-model.md',
  note: 'Definitional conversion/integration used by this product, not an external citation.',
}

const SOURCE_HPA_DOCS: FormulaSource = {
  title: 'Kubernetes Horizontal Pod Autoscaler (HPA) documentation',
  url: 'https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/',
  note: 'Proportional desiredReplicas = ceil(currentReplicas * currentMetric / targetMetric) scaling formula, plus the watermark/stabilization-window/cooldown policy shape referenced here (research.md D6, revised 2026-07-07 from a fixed +-1 step to match real HPA proportional sizing).',
}

const SOURCE_MOGUL_RAMAKRISHNAN: FormulaSource = {
  title: 'Mogul & Ramakrishnan, Eliminating Receive Livelock in an Interrupt-Driven Kernel (USENIX 1996 / ACM TOCS 1997)',
  url: 'https://www.usenix.org/legacy/publications/library/proceedings/sd96/mogul.html',
  note: 'Receive livelock: effective throughput collapsing toward zero under sustained overload rather than plateauing.',
}

const SOURCE_GUNTHER_USL: FormulaSource = {
  title: "Gunther, Guerrilla Capacity Planning / The Universal Scalability Law",
  url: 'https://www.perfdynamics.com/Manifesto/USLscalability.html',
  note: 'The retrograde-throughput region past peak concurrency this curve is a simplified, single-tunable stand-in for (research.md D2/D3).',
}

export function buildHostSaturationDescriptor(input: {
  incomingRPS: number
  capacityRPS: number
  saturationRatio: number
}): FormulaDescriptor {
  return {
    id: 'host.saturation-ratio',
    name: 'Saturation ratio (ρ)',
    expression: 'rho = incomingRPS / capacityRPS',
    inputs: { incomingRPS: input.incomingRPS, capacityRPS: input.capacityRPS },
    sources: [SOURCE_KLEINROCK],
    isBinding: input.saturationRatio >= HOST_SATURATION_THRESHOLD,
  }
}

export function buildHostLatencyDescriptor(input: {
  baseLatencyMs: number
  saturationRatio: number
  latencyMs: number
}): FormulaDescriptor {
  return {
    id: 'host.hockey-stick-latency',
    name: 'Latency under load',
    expression: `latencyMs = baseLatencyMs * (1 + rho / (1 - rho)), rho clamped to ${HOST_RHO_CLAMP}`,
    inputs: {
      baseLatencyMs: input.baseLatencyMs,
      saturationRatio: input.saturationRatio,
      rhoClamp: HOST_RHO_CLAMP,
    },
    sources: [SOURCE_KLEINROCK, SOURCE_HARCHOL_BALTER],
    isBinding: input.saturationRatio >= HOST_SATURATION_THRESHOLD,
  }
}

export function buildHostCapacityDescriptor(input: {
  maxWorkerThreads: number
  cpuProcessingTimeMs: number
  capacityRPS: number
}): FormulaDescriptor {
  return {
    id: 'host.calculated-capacity',
    name: 'Capacity from threads',
    expression: 'capacityRPS = maxWorkerThreads / (cpuProcessingTimeMs / 1000)',
    inputs: {
      maxWorkerThreads: input.maxWorkerThreads,
      cpuProcessingTimeMs: input.cpuProcessingTimeMs,
      capacityRPS: input.capacityRPS,
    },
    sources: [SOURCE_DENNING_BUZEN],
    isBinding: false,
  }
}

export function buildHostShedDescriptor(input: {
  incomingRPS: number
  manualMaxRPS: number
  shedRPS: number
}): FormulaDescriptor {
  return {
    id: 'host.max-rps-shed',
    name: 'Shed traffic beyond maxRPS',
    expression: 'shedRPS = max(0, incomingRPS - manualMaxRPS)',
    inputs: { incomingRPS: input.incomingRPS, manualMaxRPS: input.manualMaxRPS, shedRPS: input.shedRPS },
    sources: [SOURCE_PRODUCT_DATA_MODEL],
    isBinding: input.shedRPS > 0,
  }
}

// Feature 012 (Overload Collapse): the retrograde-decay formula, gated in
// flowPropagation.ts to appear only for overloadBehavior === 'collapse'
// hosts (research.md D7) — a clamp-mode host's descriptor set is unchanged.
export function buildHostCollapseDescriptor(input: {
  incomingRPS: number
  kneeRPS: number
  overloadRatio: number
  forwardedRPS: number
}): FormulaDescriptor {
  return {
    id: 'host.overload-collapse',
    name: 'Retrograde collapse past the knee',
    expression: 'forwardedRPS = kneeRPS / (1 + kappa * (overloadRatio - 1)^2), overloadRatio = incomingRPS / kneeRPS',
    inputs: {
      incomingRPS: input.incomingRPS,
      kneeRPS: input.kneeRPS,
      overloadRatio: input.overloadRatio,
      forwardedRPS: input.forwardedRPS,
    },
    sources: [SOURCE_MOGUL_RAMAKRISHNAN, SOURCE_GUNTHER_USL],
    isBinding: input.incomingRPS > input.kneeRPS,
  }
}

// Feature 012-overload-collapse refinement (research.md D9): an elastic
// scaling group (minReplicas !== maxReplicas) doesn't apply the retrograde
// curve above — its overloaded replicas crash and are evicted instead,
// which can transiently take the group to 0 serving replicas while the
// scaler boots replacements. Shown only for elastic collapse-mode hosts,
// in place of buildHostCollapseDescriptor (flowPropagation.ts).
export function buildHostReplicaEvictionDescriptor(input: {
  perReplicaSaturation: number
  effectiveReplicas: number
  evictedReplicas: number
}): FormulaDescriptor {
  return {
    id: 'host.replica-eviction',
    name: 'Overloaded replica eviction',
    expression: 'survivors = floor(effectiveReplicas / perReplicaSaturation); evictedReplicas = max(1, effectiveReplicas - survivors) when perReplicaSaturation > 1',
    inputs: {
      perReplicaSaturation: input.perReplicaSaturation,
      effectiveReplicas: input.effectiveReplicas,
      evictedReplicas: input.evictedReplicas,
    },
    sources: [SOURCE_MOGUL_RAMAKRISHNAN, SOURCE_GUNTHER_USL],
    isBinding: input.perReplicaSaturation > 1,
  }
}

export function buildEdgeRateDescriptor(input: {
  currentRPS: number
  averagePayloadSizeKB: number
  currentMBps: number
}): FormulaDescriptor {
  return {
    id: 'edge.rate-conversion',
    name: 'Edge rate (RPS -> MB/s)',
    expression: 'currentMBps = currentRPS * averagePayloadSizeKB / 1024',
    inputs: {
      currentRPS: input.currentRPS,
      averagePayloadSizeKB: input.averagePayloadSizeKB,
      currentMBps: input.currentMBps,
    },
    sources: [SOURCE_PRODUCT_DATA_MODEL],
    isBinding: false,
  }
}

export function buildEdgeConnectionsDescriptor(input: {
  currentRPS: number
  latencySec: number
  activeConnections: number
}): FormulaDescriptor {
  return {
    id: 'edge.littles-law',
    name: "Active connections (Little's law)",
    expression: 'activeConnections = currentRPS * latencySec',
    inputs: {
      currentRPS: input.currentRPS,
      latencySec: input.latencySec,
      activeConnections: input.activeConnections,
    },
    sources: [SOURCE_LITTLE],
    isBinding: false,
  }
}

export function buildEdgeCongestionDescriptor(input: {
  targetSaturationRatio: number
  isCongested: boolean
}): FormulaDescriptor {
  return {
    id: 'edge.congestion-flag',
    name: 'Congestion flag',
    expression: `isCongested = targetSaturationRatio > ${EDGE_CONGESTION_THRESHOLD}`,
    inputs: { targetSaturationRatio: input.targetSaturationRatio, congestionThreshold: EDGE_CONGESTION_THRESHOLD },
    sources: [SOURCE_PRODUCT_DATA_MODEL],
    isBinding: input.isCongested,
  }
}

export function buildQueueBacklogDescriptor(input: {
  inflowMBps: number
  outflowMBps: number
  backlogGB: number
}): FormulaDescriptor {
  return {
    id: 'queue.backlog-integration',
    name: 'Backlog integration',
    expression: 'backlogGB += (inflowMBps - outflowMBps) * windowSec / 1024, floored at 0',
    inputs: { inflowMBps: input.inflowMBps, outflowMBps: input.outflowMBps, backlogGB: input.backlogGB },
    sources: [SOURCE_PRODUCT_DATA_MODEL],
    isBinding: input.inflowMBps > input.outflowMBps,
  }
}

// Feature 013 (Host Autoscaling): replica-division and threshold-scaling-
// policy descriptors, sourced per research.md D6.

export function buildReplicaDivisionDescriptor(input: {
  incomingRPS: number
  effectiveCount: number
  perReplicaRPS: number
}): FormulaDescriptor {
  return {
    id: 'host.replica-division',
    name: 'Per-replica load division',
    expression: 'perReplicaRPS = incomingRPS / effectiveCount',
    inputs: { incomingRPS: input.incomingRPS, effectiveCount: input.effectiveCount, perReplicaRPS: input.perReplicaRPS },
    sources: [SOURCE_DENNING_BUZEN],
    isBinding: false,
  }
}

export function buildScalingPolicyDescriptor(input: {
  perReplicaSaturation: number
  highWatermark: number
  lowWatermark: number
  nominalCount: number
  minReplicas: number
  maxReplicas: number
}): FormulaDescriptor {
  return {
    id: 'host.scaling-policy',
    name: 'Proportional scaling policy',
    expression:
      'saturation >= high for sustainMs & count < max => desiredCount = ceil(count * saturation / high), clamped to [count+1, max] (after boot delay); saturation <= low for sustainMs & count > min => desiredCount = ceil(count * saturation / low), clamped to [min, count-1] (immediate); otherwise hold',
    inputs: {
      perReplicaSaturation: input.perReplicaSaturation,
      highWatermark: input.highWatermark,
      lowWatermark: input.lowWatermark,
      nominalCount: input.nominalCount,
      minReplicas: input.minReplicas,
      maxReplicas: input.maxReplicas,
    },
    sources: [SOURCE_HPA_DOCS],
    isBinding: input.perReplicaSaturation >= input.highWatermark || input.perReplicaSaturation <= input.lowWatermark,
  }
}

// Structural gate for constitution II / SC-005: every shipped formula
// descriptor must carry at least one source citation.
export function validateFormulaDescriptorsHaveSources(descriptors: FormulaDescriptor[]): void {
  for (const descriptor of descriptors) {
    if (descriptor.sources.length === 0) {
      throw new Error(`Formula "${descriptor.id}" has no source citation.`)
    }
  }
}
