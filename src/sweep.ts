// Breaking-point search (assessment.md A3 "the killer verb"): vary one
// numeric parameter on one node and binary-search for the smallest value at
// which the system stops holding. This is what turns the skill from "runs a
// sim" into "answers the question" — "will this hold at 10x, and where does
// it break first?" It's a pure loop over runSimulation + summarizeRun; the
// only new logic is the monotonic search and the "does it hold" predicate.

import { parseDiagramTopologyValue } from './diagramInput.js'
import { runSimulation, DEFAULT_RUN_SEED } from './runner.js'
import { summarizeRun, type RunSummary } from './summary.js'
import { SIM_TICK_MS } from './config.js'

export interface SweepOptions {
  /** "<nodeId>.<field>" — the numeric sim field to vary (e.g.
   *  "web-client.requestRatePerSec"). */
  param: string
  from: number
  to: number
  durationMs: number
  windowSizeMs?: number
  seed?: number
  /** Relative width of the [holds, breaks] bracket at which to stop
   *  (default 0.02 = within 2%). */
  tolerance?: number
  /** Hard cap on binary-search iterations regardless of tolerance. */
  maxIterations?: number
}

export interface SweepPoint {
  value: number
  holds: boolean
  bottleneckNodeId: string | null
  summary: RunSummary
}

export interface SweepResult {
  param: string
  from: number
  to: number
  /** Largest tested value that still held, or null if even `from` broke. */
  largestHolding: SweepPoint | null
  /** Smallest tested value that broke, or null if even `to` held. */
  smallestBreaking: SweepPoint | null
  /** Best single-number answer: the threshold between holding and breaking,
   *  taken as smallestBreaking.value (null if nothing broke in range). */
  breakingPoint: number | null
  iterations: number
}

const DEFAULT_TOLERANCE = 0.02
const DEFAULT_MAX_ITERATIONS = 24

// A run "holds" when no host is shedding or collapsing and no queue backlog
// is growing without bound at steady state. 'saturated' (rho high but still
// serving every request) still counts as holding — the break is when the
// system can no longer keep up, not merely when it's busy.
export function runHolds(summary: RunSummary): boolean {
  for (const node of summary.nodes) {
    if (node.kind === 'host' && (node.status === 'overloaded' || node.status === 'collapsed')) return false
    // A positive backlog growth rate means the queue never drains — an
    // unbounded, ever-growing buffer is a failure even if no host sheds.
    if (node.kind === 'queue' && node.backlogGrowthGBPerSec > 1e-6) return false
  }
  return true
}

// Sets diagramValue's node.<field> to `value`, reading sim from either the
// app-export nesting (data.sim) or the flattened form (sim), matching
// diagramInput's reader. Throws if the node or field can't be found so a
// typo'd --param fails loudly instead of silently sweeping nothing.
function setParam(diagramValue: unknown, nodeId: string, field: string, value: number): void {
  if (typeof diagramValue !== 'object' || diagramValue === null) throw new Error('SUGAR: diagram is not an object.')
  const nodes = (diagramValue as { nodes?: unknown }).nodes
  if (!Array.isArray(nodes)) throw new Error('SUGAR: diagram has no "nodes" array.')
  const node = nodes.find((n) => typeof n === 'object' && n !== null && (n as { id?: unknown }).id === nodeId)
  if (!node) throw new Error(`SUGAR: --param references node "${nodeId}", which is not in the diagram.`)
  const data = (node as { data?: unknown }).data
  const sim =
    typeof data === 'object' && data !== null && 'sim' in (data as Record<string, unknown>)
      ? (data as { sim?: unknown }).sim
      : (node as { sim?: unknown }).sim
  if (typeof sim !== 'object' || sim === null) {
    throw new Error(`SUGAR: node "${nodeId}" has no simulation config to vary.`)
  }
  if (!(field in (sim as Record<string, unknown>))) {
    throw new Error(`SUGAR: node "${nodeId}" has no numeric field "${field}" to sweep.`)
  }
  ;(sim as Record<string, unknown>)[field] = value
}

function evaluate(diagramValue: unknown, nodeId: string, field: string, value: number, options: SweepOptions): SweepPoint {
  setParam(diagramValue, nodeId, field, value)
  const { topology } = parseDiagramTopologyValue(diagramValue)
  const result = runSimulation(topology, {
    durationMs: options.durationMs,
    windowSizeMs: options.windowSizeMs ?? SIM_TICK_MS,
    seed: options.seed ?? DEFAULT_RUN_SEED,
  })
  const summary = summarizeRun(result.windows, result, undefined)
  const holds = runHolds(summary)
  return { value, holds, bottleneckNodeId: summary.bottleneckNodeId, summary }
}

/**
 * Binary-search the breaking point of `param` between `from` and `to`,
 * assuming more load monotonically stresses the system. `diagramValue` is a
 * parsed diagram (object), mutated in place across iterations.
 */
export function sweepParam(diagramValue: unknown, options: SweepOptions): SweepResult {
  const dot = options.param.indexOf('.')
  if (dot <= 0 || dot === options.param.length - 1) {
    throw new Error('SUGAR: --param must be "<nodeId>.<field>", e.g. "web-client.requestRatePerSec".')
  }
  const nodeId = options.param.slice(0, dot)
  const field = options.param.slice(dot + 1)
  if (!(options.from < options.to)) {
    throw new Error('SUGAR: --from must be strictly less than --to.')
  }

  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS

  let iterations = 0

  const atFrom = evaluate(diagramValue, nodeId, field, options.from, options)
  iterations += 1
  if (!atFrom.holds) {
    // Broke at the minimum — nothing in range holds.
    return { param: options.param, from: options.from, to: options.to, largestHolding: null, smallestBreaking: atFrom, breakingPoint: options.from, iterations }
  }

  const atTo = evaluate(diagramValue, nodeId, field, options.to, options)
  iterations += 1
  if (atTo.holds) {
    // Held at the maximum — no break found in range.
    return { param: options.param, from: options.from, to: options.to, largestHolding: atTo, smallestBreaking: null, breakingPoint: null, iterations }
  }

  let holding = atFrom
  let breaking = atTo
  while (iterations < maxIterations && (breaking.value - holding.value) / breaking.value > tolerance) {
    const mid = (holding.value + breaking.value) / 2
    const point = evaluate(diagramValue, nodeId, field, mid, options)
    iterations += 1
    if (point.holds) holding = point
    else breaking = point
  }

  return {
    param: options.param,
    from: options.from,
    to: options.to,
    largestHolding: holding,
    smallestBreaking: breaking,
    breakingPoint: breaking.value,
    iterations,
  }
}
