import { validateFormulaDescriptorsHaveSources } from '../formulaCatalog.js'
import type { TopologyGraph } from '../components.js'
import type { NodeModel, WindowCtx, WindowResult } from '../registry/nodeModel.js'

function emptyGraph(): TopologyGraph {
  return {
    nodeIds: [],
    simByNode: new Map(),
    outgoingEdgesByNode: new Map(),
    incomingEdgesByNode: new Map(),
    edgeById: new Map(),
    generatorNodeIds: [],
    topologicalOrder: [],
  }
}

export function makeConformanceCtx<Config, State>(model: NodeModel<Config, State>, config: Config): WindowCtx<Config, State> {
  return {
    nodeId: `${model.id}-fixture`,
    sim: config as never,
    config,
    prevState: model.initialState(config),
    incomingRPS: 100,
    incomingEdgeIds: [],
    outgoingEdgeIds: [],
    graph: emptyGraph(),
    edgeOutputRPS: new Map(),
    windowSizeMs: 1000,
    simTimeMs: 0,
    stateByNode: new Map(),
    resolveDownstreamAcceptCapacityRPS() {
      return Number.POSITIVE_INFINITY
    },
  }
}

function normalizeResult<State>(result: WindowResult<State>): unknown {
  return {
    metrics: result.metrics,
    nextState: result.nextState,
    edgeOutputRPS: Object.fromEntries(result.edgeOutputRPS),
  }
}

export function checkDeterminism<Config, State>(model: NodeModel<Config, State>, ctx: WindowCtx<Config, State>): void {
  const a = normalizeResult(model.computeWindow(ctx))
  const b = normalizeResult(model.computeWindow(ctx))
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`determinism violation: ${model.id}`)
  }
}

export function checkFiniteNumbers<Config, State>(model: NodeModel<Config, State>, result: WindowResult<State>): void {
  const values: number[] = []
  for (const value of Object.values(result.metrics)) {
    if (typeof value === 'number') values.push(value)
  }
  if (result.metrics.host) {
    for (const value of Object.values(result.metrics.host)) {
      if (typeof value === 'number') values.push(value)
    }
  }
  if (result.metrics.queue) {
    for (const value of Object.values(result.metrics.queue)) {
      if (typeof value === 'number') values.push(value)
    }
  }
  for (const value of result.edgeOutputRPS.values()) values.push(value)

  for (const value of values) {
    if (!Number.isFinite(value)) throw new Error(`finite violation: ${model.id}`)
  }
}

export function checkFlowConservation<Config, State>(model: NodeModel<Config, State>, ctx: WindowCtx<Config, State>, result: WindowResult<State>): void {
  const outflow = [...result.edgeOutputRPS.values()].reduce((sum, rps) => sum + rps, 0)
  const epsilon = 1e-6
  if (model.id === 'queue') {
    const queue = result.metrics.queue
    const prevBacklogGB = typeof ctx.prevState === 'number' ? ctx.prevState : 0
    const availableMBps = queue ? queue.inflowMBps + (prevBacklogGB * 1024) / (ctx.windowSizeMs / 1000) : 0
    if (queue && queue.outflowMBps - availableMBps > epsilon) {
      throw new Error(`flow-conservation violation: ${model.id}`)
    }
    return
  }
  if (outflow - ctx.incomingRPS > epsilon) {
    throw new Error(`flow-conservation violation: ${model.id}`)
  }
}

export function checkSourcedFormulas<Config, State>(model: NodeModel<Config, State>): void {
  validateFormulaDescriptorsHaveSources([...model.formulaDescriptors])
}

export function checkSchemaRoundTrip<Config, State>(model: NodeModel<Config, State>, config: Config): void {
  const roundTrip = JSON.parse(JSON.stringify(config)) as unknown
  const validated = model.validateConfig(roundTrip)
  if (!validated.ok) throw new Error(`schema-roundtrip violation: ${model.id}`)
}
