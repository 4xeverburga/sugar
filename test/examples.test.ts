import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseDiagramTopology } from '../src/diagramInput'
import { runSimulation } from '../src/runner'
import { summarizeRun } from '../src/summary'
import { DIAGRAM_SCHEMA_VERSION } from '../src/config'

// Regression guard for the bundled example topologies: they are the skill's
// on-ramp (SKILL.md points agents at them), so if an edit breaks one — an
// invalid config, a dangling edge, a stale schemaVersion — this catches it
// before it ships. Each must parse cleanly, carry the current schemaVersion,
// have a traffic source, and run to a summary without throwing.
const examplesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples')
const exampleFiles = readdirSync(examplesDir).filter((name) => name.endsWith('.json'))

describe('bundled examples', () => {
  it('ships at least the four documented topologies', () => {
    expect(exampleFiles.length).toBeGreaterThanOrEqual(4)
  })

  it.each(exampleFiles)('%s parses with no warnings and stamps the current schemaVersion', (name) => {
    const raw = readFileSync(path.join(examplesDir, name), 'utf-8')
    const parsed = JSON.parse(raw) as { schemaVersion?: number }
    expect(parsed.schemaVersion).toBe(DIAGRAM_SCHEMA_VERSION)

    const { topology, warnings } = parseDiagramTopology(raw)
    // A hand-maintained example should be clean — no degraded nodes, no
    // newer-version notices.
    expect(warnings).toEqual([])
    expect(topology.nodes.length).toBeGreaterThan(0)
    // Every runnable topology needs a client_pool source.
    const hasSource = topology.nodes.some((node) => node.sim.kind === 'host' && node.sim.profile === 'client_pool')
    expect(hasSource).toBe(true)
  })

  it.each(exampleFiles)('%s runs to a summary deterministically', (name) => {
    const raw = readFileSync(path.join(examplesDir, name), 'utf-8')
    const { topology, labels } = parseDiagramTopology(raw)
    const a = runSimulation(topology, { durationMs: 20_000, seed: 42 })
    const b = runSimulation(topology, { durationMs: 20_000, seed: 42 })
    expect(a.windows).toEqual(b.windows)
    const summary = summarizeRun(a.windows, a, labels)
    expect(summary.nodes.length).toBe(topology.nodes.length)
  })
})
