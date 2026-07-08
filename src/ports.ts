// The hexagonal boundary for the simulation engine (constitution Principle
// IV; contracts/engine-ports.md). Everything in this file is pure,
// structured-clone-safe data plus interfaces — the engine imports nothing
// from React/DOM/xyflow/Zustand, and nothing outside src/engine/ imports
// from here except through these shapes.

export interface FormulaSource {
  title: string
  url: string
  note?: string
}

export interface FormulaDescriptor {
  id: string
  name: string
  expression: string
  inputs: Record<string, number | string | boolean>
  sources: FormulaSource[]
  isBinding: boolean
}

/** A host's runtime archetype (data-model.md). `client_pool` is the only
 *  traffic source; `external_api` never saturates; the rest carry a
 *  manual/calculated capacity model. */
export type HostRuntimeProfile =
  | 'client_pool'
  | 'transactional_api'
  | 'worker_consumer'
  | 'database_server'
  | 'external_api'

/** A host node's behavior plus its configuration (data-model.md). Exactly
 *  the closed parameter set from FR-020 plus 013's replica bounds/boot
 *  delay — nothing else is user-facing. */
export type HostNodeSim =
  | { kind: 'host'; profile: 'client_pool'; requestRatePerSec: number }
  | { kind: 'host'; profile: 'external_api'; manualBaselineLatencyMs: number }
  | {
      kind: 'host'
      profile: 'transactional_api' | 'worker_consumer' | 'database_server'
      configMode: 'manual'
      manualBaselineLatencyMs: number
      manualSaturationRPS: number
      manualMaxRPS: number
      /** clamp: unchanged pre-012 hard cap/shed behavior; collapse: goodput
       *  decays retrograde past the knee instead of plateauing (data-model.md,
       *  research.md D1/D2). The only new field this feature adds (FR-001). */
      overloadBehavior: 'clamp' | 'collapse'
      minReplicas: number
      maxReplicas: number
      /** Simulated ms a newly-added replica takes before it serves traffic
       *  (data-model.md 013 delta) — a real, user-known infrastructure
       *  characteristic (container cold-start vs. VM boot vary by orders
       *  of magnitude), unlike the scaler's internal sustain/cooldown
       *  policy constants. */
      bootDelayMs: number
      /** Per-replica saturation ratio above which the scaler starts
       *  accumulating toward a scale-up (constitution v3.3.0 — promoted
       *  from an internal tunable to match real Kubernetes HPA, which
       *  also sets its target utilization per resource, not globally). */
      highWatermark: number
      /** Per-replica saturation ratio below which the scaler starts
       *  accumulating toward a scale-down; must be < highWatermark. */
      lowWatermark: number
    }
  | {
      kind: 'host'
      profile: 'transactional_api' | 'worker_consumer' | 'database_server'
      configMode: 'calculated'
      cpuProcessingTimeMs: number
      maxWorkerThreads: number
      overloadBehavior: 'clamp' | 'collapse'
      minReplicas: number
      maxReplicas: number
      bootDelayMs: number
      highWatermark: number
      lowWatermark: number
    }

/** A zero-configuration buffer node (data-model.md, FR-010). */
export interface QueueNodeSim {
  kind: 'queue'
}

export type NodeSim = HostNodeSim | QueueNodeSim

/** Traffic-shaping configuration living on an edge (data-model.md). Every
 *  field is required — no default parameter values (CLAUDE.md). */
export interface EdgeSimConfig {
  /** ≥ 0; normalized per source at load time when a source's outbound
   *  shares don't already sum to 1. */
  trafficShareRatio: number
  /** ≥ 0; drives RPS <-> MB/s conversion. */
  averagePayloadSizeKB: number
  /** > 0; weights a calculated-mode target host's ρ. */
  targetComputeWeightMultiplier: number
  /** ≥ 0; downstream I/O wait, and Little's law input. */
  pathIoLatencyMs: number
}

/** The engine's own view of the topology — no positions, labels, or visuals. */
export interface SimTopology {
  nodes: { id: string; sim: NodeSim }[]
  edges: { id: string; source: string; target: string; config: EdgeSimConfig }[]
}

/** One autoscaler action, retained for the bounded event ring
 *  (data-model.md ReplicaRuntime.events). */
export interface ScalingEvent {
  direction: 'up' | 'down'
  newCount: number
  simTimeMs: number
}

/** Per-window replica telemetry for a scaled host (data-model.md
 *  HostReplicaTelemetry) — present only on saturating profiles. */
export interface HostReplicaTelemetry {
  /** What the scaler manages; shown as the count badge. */
  nominalCount: number
  /** Replicas added but not yet past their boot delay. */
  bootingCount: number
  /** nominalCount - bootingCount; the serving-capacity divisor. */
  effectiveCount: number
  /** Saturation ratio of a single serving replica. */
  perReplicaSaturation: number
  /** Bounded ring, most recent last (SCALING_EVENT_HISTORY_LIMIT). */
  events: ScalingEvent[]
}

/** Per-window host telemetry (data-model.md). */
export interface HostNodeMetrics {
  incomingRPS: number
  /** After the manual-mode maxRPS clamp (research.md D6). */
  forwardedRPS: number
  /** Derived display value, not an input. */
  shedRPS: number
  /** Unclamped; display may exceed 1.0. Per-replica on scaled hosts
   *  (data-model.md 013 delta). */
  saturationRatio: number
  /** base × (1 + ρ/(1−ρ)), ρ ≤ HOST_RHO_CLAMP (research.md D2). Per-replica
   *  on scaled hosts. */
  latencyMs: number
  status: 'healthy' | 'saturated' | 'overloaded' | 'collapsed'
  /** Present only for saturating profiles (data-model.md 013 delta). */
  replicas?: HostReplicaTelemetry
}

/** Per-window queue telemetry (data-model.md). */
export interface QueueNodeMetrics {
  inflowMBps: number
  /** min(desired-by-consumers, inflow + backlog drain) (research.md D4). */
  outflowMBps: number
  /** ≥ 0, unbounded above. */
  backlogGB: number
}

/** Per-window edge telemetry (data-model.md). */
export interface EdgeSimMetrics {
  /** sourceOutput × normalizedShare. */
  currentRPS: number
  currentMBps: number
  /** Little's law: currentRPS × (latencySec of the target path). */
  activeConnections: number
  /** Target saturation > EDGE_CONGESTION_THRESHOLD. */
  isCongested: boolean
}

export interface NodeMetrics {
  /** Departures during the window, scaled to per-second. Kept for
   *  HeatEdge/back-compat. */
  throughputPerSec: number
  /** Instantaneous backlog at window end; hosts: 0, queues: backlog in
   *  messages-equivalent. */
  queueDepth: number
  host?: HostNodeMetrics
  queue?: QueueNodeMetrics
  /** Active formulas and source citations behind this node's metrics. */
  formulaDescriptors?: FormulaDescriptor[]
}

export interface EdgeMetrics {
  /** Traffic crossing the edge during the window, scaled to per-second. */
  throughputPerSec: number
  sim?: EdgeSimMetrics
  formulaDescriptors?: FormulaDescriptor[]
}

/** One aggregated snapshot, emitted at most once per `windowSizeMs`. */
export interface MetricsWindow {
  windowEndSimTimeMs: number
  nodes: Record<string, NodeMetrics>
  edges: Record<string, EdgeMetrics>
}

/** Port 1 — into the engine. */
export interface TopologyPort {
  /** Replaces the simulated topology. Called at init and on updateTopology.
   *  Throws CycleError (with the offending node ids) if the graph has a cycle. */
  loadTopology(topology: SimTopology): void
}

/** Port 2 — into the engine. The Poisson sampler is the skeleton's only
 *  implementation; spec 009+ may add bursty/trace-driven sources without
 *  touching the engine loop. */
export interface TrafficSourcePort {
  /** Returns the next inter-arrival delay in simulated ms for a source
   *  emitting at meanRatePerSec. Deterministic given the seed. */
  nextInterArrivalMs(meanRatePerSec: number): number
}

/** Port 3 — out of the engine. */
export interface MetricsSinkPort {
  /** Called at most once per aggregation window (windowSizeMs of simulated
   *  time). Never called per event. */
  emitWindow(window: MetricsWindow): void
}

/** Thrown by loadTopology/start when the simulated subgraph has a cycle
 *  (spec edge case: the simulation must not hang or overflow). */
export class CycleError extends Error {
  readonly nodeIds: string[]

  constructor(nodeIds: string[]) {
    super(`Simulation topology contains a cycle: ${nodeIds.join(' -> ')}`)
    this.name = 'CycleError'
    this.nodeIds = nodeIds
  }
}

export interface Simulation extends TopologyPort {
  start(): void
  pause(): void
  reset(): void
  /** Advances virtual time by elapsedMs, draining due events and emitting
   *  complete windows to the MetricsSinkPort. Driven by the host's clock
   *  (worker: setInterval; tests: called directly with fixed steps). A
   *  no-op while paused or idle. */
  tick(elapsedMs: number): void
}
