import { describe, expect, it } from 'vitest'
import { parseDiagramTopology, parseDiagramTopologyValue } from '../src/diagramInput'
import { LEGACY_BOOT_DELAY_MS_FOR_IMPORT, LEGACY_HIGH_WATERMARK_FOR_IMPORT, LEGACY_LOW_WATERMARK_FOR_IMPORT } from '../src/config'

const clientPool = (id: string, rate: number) => ({
  id,
  data: { label: id, sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: rate } },
})

describe('parseDiagramTopology', () => {
  it('reads the app-export nesting (data.sim / data.simConfig) into a SimTopology with labels', () => {
    const json = JSON.stringify({
      nodes: [clientPool('src', 100), { id: 'ext', data: { label: 'external', sim: { kind: 'host', profile: 'external_api', manualBaselineLatencyMs: 40 } } }],
      edges: [
        {
          id: 'e1',
          source: 'src',
          target: 'ext',
          data: { simConfig: { trafficShareRatio: 1, averagePayloadSizeKB: 2, targetComputeWeightMultiplier: 1, pathIoLatencyMs: 0 } },
        },
      ],
    })
    const { topology, labels } = parseDiagramTopology(json)
    expect(topology.nodes.map((node) => node.id)).toEqual(['src', 'ext'])
    expect(topology.edges).toHaveLength(1)
    expect(labels.get('src')).toBe('src')
    expect(labels.get('ext')).toBe('external')
  })

  it('also reads a flattened form (sim/config directly on node/edge) so hand-authored JSON works', () => {
    const json = JSON.stringify({
      nodes: [
        { id: 'src', label: 'src', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 50 } },
        { id: 'q', label: 'q', sim: { kind: 'queue' } },
      ],
      edges: [{ id: 'e1', source: 'src', target: 'q', config: { trafficShareRatio: 1, averagePayloadSizeKB: 1, targetComputeWeightMultiplier: 1, pathIoLatencyMs: 0 } }],
    })
    const { topology } = parseDiagramTopology(json)
    expect(topology.nodes).toHaveLength(2)
    expect(topology.edges).toHaveLength(1)
  })

  it('back-fills a pre-013 compute host with legacy replica/boot/watermark values', () => {
    const json = JSON.stringify({
      nodes: [
        {
          id: 'api',
          data: {
            label: 'api',
            sim: { kind: 'host', profile: 'transactional_api', configMode: 'manual', manualBaselineLatencyMs: 10, manualSaturationRPS: 500, manualMaxRPS: 600 },
          },
        },
      ],
      edges: [],
    })
    const { topology } = parseDiagramTopologyValue(JSON.parse(json))
    expect(topology.nodes[0].sim).toEqual({
      kind: 'host',
      profile: 'transactional_api',
      configMode: 'manual',
      manualBaselineLatencyMs: 10,
      manualSaturationRPS: 500,
      manualMaxRPS: 600,
      overloadBehavior: 'clamp',
      minReplicas: 1,
      maxReplicas: 1,
      bootDelayMs: LEGACY_BOOT_DELAY_MS_FOR_IMPORT,
      highWatermark: LEGACY_HIGH_WATERMARK_FOR_IMPORT,
      lowWatermark: LEGACY_LOW_WATERMARK_FOR_IMPORT,
    })
  })

  it('degrades an unrecognized/retired sim role to a plain node and reports a warning', () => {
    const json = JSON.stringify({
      nodes: [clientPool('src', 100), { id: 'old', data: { label: 'old', sim: { role: 'generator', ratePerSec: 100 } } }],
      edges: [],
    })
    const { topology, warnings } = parseDiagramTopology(json)
    expect(topology.nodes.map((node) => node.id)).toEqual(['src'])
    expect(warnings.some((warning) => warning.includes('plain'))).toBe(true)
  })

  it('warns when the file schemaVersion is newer than this build supports', () => {
    const json = JSON.stringify({ schemaVersion: 999, nodes: [clientPool('src', 10)], edges: [] })
    const { warnings } = parseDiagramTopology(json)
    expect(warnings.some((warning) => warning.includes('newer'))).toBe(true)
  })

  it('does not warn for a file at or below the current schemaVersion', () => {
    const json = JSON.stringify({ schemaVersion: 1, nodes: [clientPool('src', 10)], edges: [] })
    const { warnings } = parseDiagramTopology(json)
    expect(warnings).toHaveLength(0)
  })

  it('throws on non-JSON, missing arrays, and a node with no id', () => {
    expect(() => parseDiagramTopology('not json')).toThrow('valid JSON')
    expect(() => parseDiagramTopology('{}')).toThrow('nodes')
    expect(() => parseDiagramTopology(JSON.stringify({ nodes: [{ data: {} }], edges: [] }))).toThrow('id')
  })
})
