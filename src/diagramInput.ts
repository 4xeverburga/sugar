// The engine-side reader for the diagram-JSON interchange format
// (assessment.md A4 "input schema" + A6 "UI-topology vs engine-topology").
// It turns the JSON an agent authors — or the app exports — into the
// structural TopologyNodeInput/TopologyEdgeInput shapes buildSimTopology
// accepts, while also carrying each node's human label through so summaries
// stay readable (A2/A6). The written contract this code implements lives in
// SCHEMA.md; the two must stay in step.
//
// Validation here mirrors diagram-lab's plainNodeSim/plainEdgeSimConfig
// tolerance (src/lab/exportDiagram.ts) so a diagram authored in the canvas
// runs byte-for-byte identically under the CLI: recognized sim configs are
// kept, absent capability fields back-fill through the same LEGACY_*_FOR_
// IMPORT constants, and anything unrecognized degrades to a plain (non-
// simulated) node rather than throwing. The only hard errors are structural
// (not an object, missing nodes/edges arrays, a node/edge without an id) —
// the same floor parseDiagram enforces.

import {
  DIAGRAM_SCHEMA_VERSION,
  LEGACY_BOOT_DELAY_MS_FOR_IMPORT,
  LEGACY_HIGH_WATERMARK_FOR_IMPORT,
  LEGACY_LOW_WATERMARK_FOR_IMPORT,
  LEGACY_OVERLOAD_BEHAVIOR_FOR_IMPORT,
} from './config.js'
import { registry } from './registry/index.js'
import { buildSimTopology } from './topology.js'
import type { EdgeSimConfig, NodeSim, SimTopology } from './ports.js'

export interface ParsedDiagram {
  topology: SimTopology
  /** node id -> display label, for readable summaries. Nodes with no label
   *  fall back to their id at the call site. */
  labels: Map<string, string>
  /** Non-fatal notices (newer schema version, degraded nodes) for the
   *  caller to surface once. */
  warnings: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateThroughRegistry(sim: NodeSim): NodeSim | undefined {
  const model = registry.resolve(sim)
  if (!model) return undefined
  const validated = model.validateConfig(sim)
  if (!validated.ok) return undefined
  return validated.value as NodeSim
}

// Recognizes exactly the closed HostNodeSim/QueueNodeSim parameter set,
// back-filling capability fields added after the original 011 shape from
// their LEGACY_*_FOR_IMPORT values when absent (identical semantics to
// diagram-lab's plainNodeSim). Returns undefined for anything unrecognized
// — the node still exists visually, it just doesn't participate in the sim.
function parseNodeSim(value: unknown): NodeSim | undefined {
  if (!isRecord(value)) return undefined
  if (value.kind === 'queue') return validateThroughRegistry({ kind: 'queue' })
  if (value.kind !== 'host') return undefined

  if (value.profile === 'client_pool' && isFiniteNumber(value.requestRatePerSec) && value.requestRatePerSec >= 0) {
    return validateThroughRegistry({ kind: 'host', profile: 'client_pool', requestRatePerSec: value.requestRatePerSec })
  }
  if (value.profile === 'external_api' && isFiniteNumber(value.manualBaselineLatencyMs) && value.manualBaselineLatencyMs >= 0) {
    return validateThroughRegistry({ kind: 'host', profile: 'external_api', manualBaselineLatencyMs: value.manualBaselineLatencyMs })
  }

  const computeProfile = value.profile === 'transactional_api' || value.profile === 'worker_consumer' || value.profile === 'database_server'
  if (!computeProfile) return undefined
  const profile = value.profile as 'transactional_api' | 'worker_consumer' | 'database_server'

  const isValidReplicaBound = (n: unknown): n is number => isFiniteNumber(n) && Number.isInteger(n) && n >= 1
  const hasReplicaFields = 'minReplicas' in value || 'maxReplicas' in value
  const minReplicas = hasReplicaFields && isValidReplicaBound(value.minReplicas) ? value.minReplicas : 1
  const maxReplicas = hasReplicaFields && isValidReplicaBound(value.maxReplicas) && value.maxReplicas >= minReplicas ? value.maxReplicas : 1

  const bootDelayMs = isFiniteNumber(value.bootDelayMs) && value.bootDelayMs >= 0 ? value.bootDelayMs : LEGACY_BOOT_DELAY_MS_FOR_IMPORT

  const isValidWatermark = (n: unknown): n is number => isFiniteNumber(n) && n >= 0
  const hasWatermarkFields = 'highWatermark' in value || 'lowWatermark' in value
  const highWatermark = hasWatermarkFields && isValidWatermark(value.highWatermark) ? value.highWatermark : LEGACY_HIGH_WATERMARK_FOR_IMPORT
  const lowWatermark =
    hasWatermarkFields && isValidWatermark(value.lowWatermark) && value.lowWatermark < highWatermark
      ? value.lowWatermark
      : LEGACY_LOW_WATERMARK_FOR_IMPORT

  const overloadBehavior: 'clamp' | 'collapse' =
    value.overloadBehavior === 'clamp' || value.overloadBehavior === 'collapse' ? value.overloadBehavior : LEGACY_OVERLOAD_BEHAVIOR_FOR_IMPORT

  if (
    value.configMode === 'manual' &&
    isFiniteNumber(value.manualBaselineLatencyMs) &&
    value.manualBaselineLatencyMs >= 0 &&
    isFiniteNumber(value.manualSaturationRPS) &&
    value.manualSaturationRPS >= 0 &&
    isFiniteNumber(value.manualMaxRPS) &&
    value.manualMaxRPS >= value.manualSaturationRPS
  ) {
    return validateThroughRegistry({
      kind: 'host',
      profile,
      configMode: 'manual',
      manualBaselineLatencyMs: value.manualBaselineLatencyMs,
      manualSaturationRPS: value.manualSaturationRPS,
      manualMaxRPS: value.manualMaxRPS,
      overloadBehavior,
      minReplicas,
      maxReplicas,
      bootDelayMs,
      highWatermark,
      lowWatermark,
    })
  }
  if (
    value.configMode === 'calculated' &&
    isFiniteNumber(value.cpuProcessingTimeMs) &&
    value.cpuProcessingTimeMs >= 0 &&
    isFiniteNumber(value.maxWorkerThreads) &&
    value.maxWorkerThreads >= 0
  ) {
    return validateThroughRegistry({
      kind: 'host',
      profile,
      configMode: 'calculated',
      cpuProcessingTimeMs: value.cpuProcessingTimeMs,
      maxWorkerThreads: value.maxWorkerThreads,
      overloadBehavior,
      minReplicas,
      maxReplicas,
      bootDelayMs,
      highWatermark,
      lowWatermark,
    })
  }
  return undefined
}

function parseEdgeSimConfig(value: unknown): EdgeSimConfig | undefined {
  if (!isRecord(value)) return undefined
  if (
    isFiniteNumber(value.trafficShareRatio) &&
    value.trafficShareRatio >= 0 &&
    isFiniteNumber(value.averagePayloadSizeKB) &&
    value.averagePayloadSizeKB >= 0 &&
    isFiniteNumber(value.targetComputeWeightMultiplier) &&
    value.targetComputeWeightMultiplier > 0 &&
    isFiniteNumber(value.pathIoLatencyMs) &&
    value.pathIoLatencyMs >= 0
  ) {
    return {
      trafficShareRatio: value.trafficShareRatio,
      averagePayloadSizeKB: value.averagePayloadSizeKB,
      targetComputeWeightMultiplier: value.targetComputeWeightMultiplier,
      pathIoLatencyMs: value.pathIoLatencyMs,
    }
  }
  return undefined
}

// The diagram JSON nests sim config under data.sim / data.simConfig (the
// app-export shape). The engine also accepts a flattened form (sim/config
// directly on the node/edge) so an agent hand-authoring JSON isn't forced to
// mimic React Flow's data wrapper — both are read here.
function readNodeSim(node: Record<string, unknown>): unknown {
  const data = isRecord(node.data) ? node.data : undefined
  return data && 'sim' in data ? data.sim : node.sim
}

function readNodeLabel(node: Record<string, unknown>): string | undefined {
  const data = isRecord(node.data) ? node.data : undefined
  const label = data?.label ?? node.label
  return typeof label === 'string' ? label : undefined
}

function readEdgeConfig(edge: Record<string, unknown>): unknown {
  const data = isRecord(edge.data) ? edge.data : undefined
  return data && 'simConfig' in data ? data.simConfig : edge.config ?? edge.simConfig
}

/**
 * Parse a diagram-JSON document (as a string) into an engine SimTopology plus
 * a label map. Throws on structural malformation; degrades unrecognized sim
 * config to plain nodes with a warning rather than throwing (SCHEMA.md
 * compatibility policy).
 */
export function parseDiagramTopology(json: string): ParsedDiagram {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('SUGAR: input is not valid JSON.')
  }
  return parseDiagramTopologyValue(parsed)
}

/** Same as parseDiagramTopology but from an already-parsed value — used by
 *  the sweep runner, which mutates a parsed diagram in memory between runs. */
export function parseDiagramTopologyValue(parsed: unknown): ParsedDiagram {
  const warnings: string[] = []
  if (!isRecord(parsed) || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error('SUGAR: expected an object with "nodes" and "edges" arrays.')
  }

  if (isFiniteNumber(parsed.schemaVersion) && parsed.schemaVersion > DIAGRAM_SCHEMA_VERSION) {
    warnings.push(
      `input schemaVersion ${parsed.schemaVersion} is newer than this build supports (${DIAGRAM_SCHEMA_VERSION}); unrecognized fields were ignored.`,
    )
  }

  const labels = new Map<string, string>()
  let degradedCount = 0

  const nodeInputs = parsed.nodes.map((raw, index) => {
    if (!isRecord(raw) || typeof raw.id !== 'string') {
      throw new Error(`SUGAR: node at index ${index} is missing a string "id".`)
    }
    const label = readNodeLabel(raw)
    if (label !== undefined) labels.set(raw.id, label)
    const rawSim = readNodeSim(raw)
    const sim = parseNodeSim(rawSim)
    if (rawSim !== undefined && rawSim !== null && sim === undefined) degradedCount += 1
    return { id: raw.id, sim }
  })

  const edgeInputs = parsed.edges.map((raw, index) => {
    if (!isRecord(raw) || typeof raw.id !== 'string') {
      throw new Error(`SUGAR: edge at index ${index} is missing a string "id".`)
    }
    if (typeof raw.source !== 'string' || typeof raw.target !== 'string') {
      throw new Error(`SUGAR: edge "${raw.id}" is missing a string "source"/"target".`)
    }
    return { id: raw.id, source: raw.source, target: raw.target, config: parseEdgeSimConfig(readEdgeConfig(raw)) }
  })

  if (degradedCount > 0) {
    warnings.push(
      `${degradedCount} node(s) had an unrecognized or retired sim config and were treated as plain (non-simulated) nodes.`,
    )
  }

  return { topology: buildSimTopology(nodeInputs, edgeInputs), labels, warnings }
}
