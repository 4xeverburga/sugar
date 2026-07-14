import { buildRegistry } from './registry.js'
import { clientPoolModel } from './models/clientPoolModel.js'
import { externalApiModel } from './models/externalApiModel.js'
import { queueModel } from './models/queueModel.js'
import { saturatingHostModel } from './models/saturatingHostModel.js'

export const registry = buildRegistry([clientPoolModel, externalApiModel, saturatingHostModel, queueModel])

export { resolveModelId } from './resolve.js'
export type { NodeModel, ParamSchema, Result, WindowCtx, WindowResult } from './nodeModel.js'
export type { Registry } from './registry.js'
