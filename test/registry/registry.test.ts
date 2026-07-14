import { describe, expect, it } from 'vitest'
import { buildRegistry } from '../../src/registry/registry'
import { queueModel } from '../../src/registry/models/queueModel'

describe('registry buildRegistry', () => {
  it('throws on duplicate ids', () => {
    expect(() => buildRegistry([queueModel, queueModel])).toThrow(/duplicate registry model id/i)
  })

  it('throws on incomplete model contracts', () => {
    const incomplete = {
      id: 'broken',
      label: 'Broken',
      validateConfig: () => ({ ok: true as const, value: {} }),
    }
    expect(() => buildRegistry([incomplete as never])).toThrow(/incomplete/i)
  })
})
