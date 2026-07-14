import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDiagramTopology } from '../../src/diagramInput'
import { runSimulation } from '../../src/runner'
import { summarizeRun } from '../../src/summary'

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const examplesDir = path.join(rootDir, 'examples')
const goldenDir = path.join(rootDir, 'test', 'golden')
const exampleFiles = readdirSync(examplesDir).filter((name) => name.endsWith('.json'))

describe('golden parity', () => {
  it.each(exampleFiles)('%s summary matches golden output with seed 1', (name) => {
    const exampleRaw = readFileSync(path.join(examplesDir, name), 'utf-8')
    const goldenRaw = readFileSync(path.join(goldenDir, `${path.basename(name, '.json')}.json`), 'utf-8')

    const parsed = parseDiagramTopology(exampleRaw)
    const run = runSimulation(parsed.topology, { durationMs: 120_000, seed: 1 })
    const actual = { warnings: parsed.warnings, summary: summarizeRun(run.windows, run, parsed.labels) }

    expect(JSON.parse(goldenRaw)).toEqual(actual)
  })
})
