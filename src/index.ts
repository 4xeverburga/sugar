// Public API surface of the simulation engine (assessment.md A4). Everything
// exported from this barrel is the supported, documented contract — the
// engine's other modules (formulaCatalog, autoscaler, components, etc.) are
// implementation details that may churn and should not be imported directly
// by consumers outside this package. Every import into the engine from the
// app layer (or a future headless CLI runner) should go through here.

export { createSimulation } from './simulation'

export {
  buildSimTopology,
  hasGeneratorRole,
  type TopologyNodeInput,
  type TopologyEdgeInput,
} from './topology'

export { PoissonTrafficSource, mulberry32, type RandomSource } from './poisson'

export {
  SIM_TICK_MS,
  HOST_RHO_CLAMP,
  HOST_SATURATION_THRESHOLD,
  EDGE_CONGESTION_THRESHOLD,
  HOST_ZERO_CAPACITY_EPSILON,
  BYTES_PER_KB,
  KB_PER_MB,
  MB_PER_GB,
  HOST_COLLAPSE_DECAY_KAPPA,
  HOST_COLLAPSE_STATUS_RATIO,
  HOST_COLLAPSE_DEAD_SATURATION_RATIO,
} from './config'

export type {
  FormulaSource,
  FormulaDescriptor,
  HostRuntimeProfile,
  HostNodeSim,
  QueueNodeSim,
  NodeSim,
  EdgeSimConfig,
  SimTopology,
  ScalingEvent,
  HostReplicaTelemetry,
  HostNodeMetrics,
  QueueNodeMetrics,
  EdgeSimMetrics,
  NodeMetrics,
  EdgeMetrics,
  MetricsWindow,
  TopologyPort,
  TrafficSourcePort,
  MetricsSinkPort,
  Simulation,
} from './ports'

export { CycleError } from './ports'
