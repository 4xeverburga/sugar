import type { NodeSim } from '../ports.js'
import type { NodeModel } from './nodeModel.js'
import { resolveModelId } from './resolve.js'

export interface Registry {
  byKind: ReadonlyMap<string, NodeModel>
  resolve(sim: NodeSim): NodeModel | undefined
}

function isModelComplete(model: NodeModel): boolean {
  return Boolean(
    model &&
      typeof model.id === 'string' &&
      model.id.length > 0 &&
      typeof model.label === 'string' &&
      typeof model.validateConfig === 'function' &&
      typeof model.initialState === 'function' &&
      typeof model.reconcileState === 'function' &&
      typeof model.acceptCapacityRPS === 'function' &&
      typeof model.computeWindow === 'function' &&
      model.paramSchema !== undefined &&
      Array.isArray(model.formulaDescriptors),
  )
}

export function buildRegistry(models: readonly NodeModel[]): Registry {
  const byKind = new Map<string, NodeModel>()
  for (const model of models) {
    if (!isModelComplete(model)) {
      throw new Error('SUGAR: registry model is incomplete and cannot be registered.')
    }
    if (byKind.has(model.id)) {
      throw new Error(`SUGAR: duplicate registry model id "${model.id}".`)
    }
    byKind.set(model.id, model)
  }
  return {
    byKind,
    resolve(sim: NodeSim): NodeModel | undefined {
      return byKind.get(resolveModelId(sim))
    },
  }
}
