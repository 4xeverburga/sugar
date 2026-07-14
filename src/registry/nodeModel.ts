import type { TopologyGraph } from '../components.js'
import type { FormulaDescriptor, NodeMetrics, NodeSim } from '../ports.js'

export interface ResultOk<T> {
  ok: true
  value: T
}

export interface ResultErr {
  ok: false
  message: string
}

export type Result<T> = ResultOk<T> | ResultErr

export interface ParamSchemaParam {
  name: string
  type: 'number' | 'enum'
  unit?: string
  min?: number
  max?: number
  options?: string[]
}

export interface ParamSchema {
  params: ParamSchemaParam[]
}

export interface WindowCtx<Config, State> {
  nodeId: string
  sim: NodeSim
  config: Config
  prevState: State
  incomingRPS: number
  incomingEdgeIds: readonly string[]
  outgoingEdgeIds: readonly string[]
  graph: TopologyGraph
  edgeOutputRPS: ReadonlyMap<string, number>
  windowSizeMs: number
  simTimeMs: number
  stateByNode: ReadonlyMap<string, unknown>
  resolveDownstreamAcceptCapacityRPS: (edgeId: string) => number
}

export interface WindowResult<State> {
  metrics: NodeMetrics
  nextState: State
  edgeOutputRPS: ReadonlyMap<string, number>
}

export interface WindowCtxForNode<Config, State> {
  simTimeMs: number
  windowSizeMs: number
  stateByNode: ReadonlyMap<string, unknown>
  graph: TopologyGraph
  nodeId: string
  sim: NodeSim
  config: Config
  previousState: State
}

export interface NodeModel<Config = unknown, State = unknown> {
  readonly id: string
  readonly label: string
  readonly paramSchema: ParamSchema
  readonly formulaDescriptors: readonly FormulaDescriptor[]
  validateConfig(raw: unknown): Result<Config>
  initialState(config: Config): State
  reconcileState(input: WindowCtxForNode<Config, State>): State
  acceptCapacityRPS(config: Config, state: State): number
  computeWindow(ctx: WindowCtx<Config, State>): WindowResult<State>
}
