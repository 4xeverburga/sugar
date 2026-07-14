import { describe, expect, it } from 'vitest'
import {
  LEGACY_BOOT_DELAY_MS_FOR_IMPORT,
  LEGACY_HIGH_WATERMARK_FOR_IMPORT,
  LEGACY_LOW_WATERMARK_FOR_IMPORT,
} from '../../src/config'
import { parseDiagramTopologyValue } from '../../src/diagramInput'
import { runSimulation } from '../../src/runner'
import { summarizeRun } from '../../src/summary'

function runSummary(diagram: unknown): { warnings: string[]; summary: ReturnType<typeof summarizeRun> } {
  const parsed = parseDiagramTopologyValue(diagram)
  const run = runSimulation(parsed.topology, { durationMs: 60_000, seed: 1 })
  return {
    warnings: parsed.warnings,
    summary: summarizeRun(run.windows, run, parsed.labels),
  }
}

describe('registry backward compatibility', () => {
  it('pre-refactor host configs import and run identically to explicit modern shape', () => {
    const legacyDiagram = {
      nodes: [
        {
          id: 'src',
          data: { label: 'src', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 180 } },
        },
        {
          id: 'api',
          data: {
            label: 'api',
            sim: {
              kind: 'host',
              profile: 'transactional_api',
              configMode: 'manual',
              manualBaselineLatencyMs: 8,
              manualSaturationRPS: 450,
              manualMaxRPS: 500,
            },
          },
        },
        {
          id: 'db',
          data: {
            label: 'db',
            sim: {
              kind: 'host',
              profile: 'database_server',
              configMode: 'calculated',
              cpuProcessingTimeMs: 6,
              maxWorkerThreads: 32,
            },
          },
        },
      ],
      edges: [
        {
          id: 'e1',
          source: 'src',
          target: 'api',
          data: {
            simConfig: {
              trafficShareRatio: 1,
              averagePayloadSizeKB: 1.5,
              targetComputeWeightMultiplier: 1,
              pathIoLatencyMs: 0,
            },
          },
        },
        {
          id: 'e2',
          source: 'api',
          target: 'db',
          data: {
            simConfig: {
              trafficShareRatio: 1,
              averagePayloadSizeKB: 2,
              targetComputeWeightMultiplier: 1,
              pathIoLatencyMs: 1,
            },
          },
        },
      ],
    }

    const modernDiagram = {
      nodes: [
        {
          id: 'src',
          data: { label: 'src', sim: { kind: 'host', profile: 'client_pool', requestRatePerSec: 180 } },
        },
        {
          id: 'api',
          data: {
            label: 'api',
            sim: {
              kind: 'host',
              profile: 'transactional_api',
              configMode: 'manual',
              manualBaselineLatencyMs: 8,
              manualSaturationRPS: 450,
              manualMaxRPS: 500,
              overloadBehavior: 'clamp',
              minReplicas: 1,
              maxReplicas: 1,
              bootDelayMs: LEGACY_BOOT_DELAY_MS_FOR_IMPORT,
              highWatermark: LEGACY_HIGH_WATERMARK_FOR_IMPORT,
              lowWatermark: LEGACY_LOW_WATERMARK_FOR_IMPORT,
            },
          },
        },
        {
          id: 'db',
          data: {
            label: 'db',
            sim: {
              kind: 'host',
              profile: 'database_server',
              configMode: 'calculated',
              cpuProcessingTimeMs: 6,
              maxWorkerThreads: 32,
              overloadBehavior: 'clamp',
              minReplicas: 1,
              maxReplicas: 1,
              bootDelayMs: LEGACY_BOOT_DELAY_MS_FOR_IMPORT,
              highWatermark: LEGACY_HIGH_WATERMARK_FOR_IMPORT,
              lowWatermark: LEGACY_LOW_WATERMARK_FOR_IMPORT,
            },
          },
        },
      ],
      edges: legacyDiagram.edges,
    }

    const legacy = runSummary(legacyDiagram)
    const modern = runSummary(modernDiagram)

    expect(legacy.warnings).toEqual([])
    expect(modern.warnings).toEqual([])
    expect(legacy.summary).toEqual(modern.summary)
  })
})
