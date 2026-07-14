import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDiagramTopology } from '../../src/diagramInput'
import { runSimulation } from '../../src/runner'
import { summarizeRun } from '../../src/summary'

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const examplesDir = path.join(rootDir, 'examples')
const exampleFiles = readdirSync(examplesDir).filter((name) => name.endsWith('.json'))

describe('registry determinism', () => {
  it.each(exampleFiles)('%s produces identical summaries for the same seed', (name) => {
    const raw = readFileSync(path.join(examplesDir, name), 'utf-8')
    const parsed = parseDiagramTopology(raw)

    const a = runSimulation(parsed.topology, { durationMs: 120_000, seed: 1 })
    const b = runSimulation(parsed.topology, { durationMs: 120_000, seed: 1 })

    expect(summarizeRun(a.windows, a, parsed.labels)).toEqual(summarizeRun(b.windows, b, parsed.labels))
  })
})
