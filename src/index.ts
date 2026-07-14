// Public API surface of the simulation engine (assessment.md A4). Everything
// exported from this barrel is the supported, documented contract — the
// engine's other modules (formulaCatalog, autoscaler, components, etc.) are
// implementation details that may churn and should not be imported directly
// by consumers outside this package. Every import into the engine from the
// app layer (or a future headless CLI runner) should go through here.

export { createSimulation } from './simulation.js'

export {
  buildSimTopology,
  hasGeneratorRole,
  type TopologyNodeInput,
  type TopologyEdgeInput,
} from './topology.js'

export { PoissonTrafficSource, mulberry32, type RandomSource } from './poisson.js'

// Headless runner + agent-facing reductions (assessment.md Goal A). These
// are what the CLI is built on and what a programmatic consumer (a test, a
// server, another agent tool) would call directly.
export { runSimulation, DEFAULT_RUN_SEED, type RunOptions, type RunResult } from './runner.js'

export {
  summarizeRun,
  type RunSummary,
  type NodeSummary,
  type HostNodeSummary,
  type QueueNodeSummary,
  type SaturationEvent,
  type NodeKind,
} from './summary.js'

export { sweepParam, runHolds, type SweepOptions, type SweepResult, type SweepPoint } from './sweep.js'

export { parseDiagramTopology, parseDiagramTopologyValue, type ParsedDiagram } from './diagramInput.js'
export { registry, resolveModelId } from './registry/index.js'
export type { Registry } from './registry/registry.js'
export type { NodeModel, ParamSchema, Result, WindowCtx, WindowResult } from './registry/nodeModel.js'

export {
  SIM_TICK_MS,
  DIAGRAM_SCHEMA_VERSION,
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
  MAX_DISCRETE_CAPACITY_SEGMENTS,
  SPARKLINE_HISTORY_LENGTH,
  LEGACY_BOOT_DELAY_MS_FOR_IMPORT,
  LEGACY_HIGH_WATERMARK_FOR_IMPORT,
  LEGACY_LOW_WATERMARK_FOR_IMPORT,
  LEGACY_OVERLOAD_BEHAVIOR_FOR_IMPORT,
} from './config.js'

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
} from './ports.js'

export { CycleError } from './ports.js'
