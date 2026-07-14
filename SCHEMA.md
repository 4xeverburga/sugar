# Diagram JSON schema

This is the written contract for the topology format SUGAR reads and writes —
the same JSON the [canvas](https://github.com/4xeverburga/sugar) exports, the
CLI runner (`sugar run` / `sugar sweep`) reads, an agent authors, and a share
link carries. It is the human counterpart to the executable validator in
[`src/diagramInput.ts`](src/diagramInput.ts); the two are kept in step.

Current `schemaVersion`: **1**.

Registry note: the node-model registry (`src/registry/`) is an internal
dispatch mechanism. It does not change the serialized `kind` / `profile`
shape and therefore does not require a schema version bump.

## Top-level shape

```json
{
  "schemaVersion": 1,
  "nodes": [ /* Node[] */ ],
  "edges": [ /* Edge[] */ ]
}
```

- **`schemaVersion`** (integer, optional): how many additive revisions of this
  format have shipped. It is **not** semver — the format only ever grows by
  adding optional fields whose absence back-fills to prior behavior, so an
  ordinal is all a parser needs. A file with no `schemaVersion` is treated as
  legacy (pre-versioning) and parsed on its field contents alone.
- **`nodes`**, **`edges`** (required arrays): the graph. Both must be present,
  even if empty.

### Compatibility policy

- A parser accepts any file whose `schemaVersion` is **≤ its own**
  `DIAGRAM_SCHEMA_VERSION`, forever. Old exports never rot.
- A file with a **newer** `schemaVersion` is still parsed best-effort: fields
  the parser doesn't recognize are ignored, unknown node kinds/profiles
  degrade to plain (non-simulated) nodes, and a one-time notice is surfaced.
- Absent capability fields back-fill to the exact value that reproduced the
  behavior before that field existed (see the `LEGACY_*_FOR_IMPORT` constants),
  never a guessed default.

Bump `schemaVersion` (and this document) in the same release that adds a new
schema-visible field.

## Nodes

A node needs an `id` and a label. Its simulation role lives under `data.sim`
(the canvas-export nesting); the CLI also accepts a flattened `sim` directly on
the node for hand-authoring. A node with no recognized `sim` is a plain visual
node and does not participate in the simulation.

```json
{
  "id": "api-gateway",
  "type": "labelNode",
  "position": { "x": 260, "y": 200 },
  "data": { "label": "api gateway", "sim": { /* NodeSim */ } }
}
```

- **`id`** (string, required): unique within the diagram; edges reference it.
- **`data.label`** (string): display name, used verbatim in summaries. Falls
  back to `id` if absent.
- **`type`**, **`position`**, `width`, `height`, `className`, `data.image`,
  `data.imageAspect`, `data.labelSize`: canvas presentation fields. The engine
  ignores them; they round-trip through the canvas untouched.

### NodeSim variants

A simulation node is either a **host** (`kind: "host"`) with one of five
profiles, or a **queue** (`kind: "queue"`).

#### `client_pool` — the traffic source

The only profile that emits load with no inbound edge. At least one is required
for a runnable simulation.

| field | type | constraint | meaning |
| --- | --- | --- | --- |
| `requestRatePerSec` | number | ≥ 0 | mean Poisson arrival rate (RPS) |

#### `external_api` — a bottomless third-party call

Never saturates; models a fixed-latency dependency you don't control.

| field | type | constraint | meaning |
| --- | --- | --- | --- |
| `manualBaselineLatencyMs` | number | ≥ 0 | fixed response latency (ms) |

#### `transactional_api` / `worker_consumer` / `database_server` — compute hosts

These three profiles share one parameter set and differ only in labeling
intent. Each is configured in **`manual`** or **`calculated`** mode.

Common fields (all profiles, both modes):

| field | type | constraint | meaning |
| --- | --- | --- | --- |
| `overloadBehavior` | `"clamp"` \| `"collapse"` | — | past the knee: hard-cap goodput (`clamp`) or let it decay retrograde (`collapse`) |
| `minReplicas` | integer | ≥ 1, ≤ `maxReplicas` | autoscaler floor |
| `maxReplicas` | integer | ≥ `minReplicas` | autoscaler ceiling |
| `bootDelayMs` | number | ≥ 0 | simulated ms a new replica takes before serving |
| `highWatermark` | number | ≥ 0 | per-replica saturation that triggers scale-up |
| `lowWatermark` | number | ≥ 0, < `highWatermark` | per-replica saturation that triggers scale-down |

`manual` mode adds:

| field | type | constraint | meaning |
| --- | --- | --- | --- |
| `configMode` | `"manual"` | — | mode discriminator |
| `manualBaselineLatencyMs` | number | ≥ 0 | latency at zero load (ms) |
| `manualSaturationRPS` | number | ≥ 0 | the knee — RPS at which ρ = 1 per replica |
| `manualMaxRPS` | number | ≥ `manualSaturationRPS` | hard cap on forwarded RPS per replica |

`calculated` mode adds:

| field | type | constraint | meaning |
| --- | --- | --- | --- |
| `configMode` | `"calculated"` | — | mode discriminator |
| `cpuProcessingTimeMs` | number | ≥ 0 | per-request service time (ms) |
| `maxWorkerThreads` | number | ≥ 0 | concurrent threads; capacity ≈ `maxWorkerThreads / cpuProcessingTimeMs` |

#### `queue` — a zero-config buffer

```json
{ "kind": "queue" }
```

No parameters. Buffers flow between a producer and a consumer; backlog grows
when the consumer can't keep up.

## Edges

An edge carries traffic-shaping config under `data.simConfig` (canvas nesting)
or a flattened `config` (hand-authoring). An edge whose config is missing or
incomplete is dropped from the simulation rather than guessed — it isn't ready
to simulate yet.

```json
{
  "id": "api-gateway-postgres-db",
  "source": "api-gateway",
  "target": "postgres-db",
  "type": "heat",
  "data": { "simConfig": { /* EdgeSimConfig */ } }
}
```

- **`id`** (string, required), **`source`** / **`target`** (string, required):
  must reference node ids present in the diagram.
- **`data.simConfig`** — all four fields required (no partial configs):

| field | type | constraint | meaning |
| --- | --- | --- | --- |
| `trafficShareRatio` | number | ≥ 0 | fraction of the source's output on this edge; **not** normalized to sum to 1, so a fan-out can split, broadcast, or both |
| `averagePayloadSizeKB` | number | ≥ 0 | per-request payload; drives RPS ↔ MB/s |
| `targetComputeWeightMultiplier` | number | > 0 | weights this path's load on a calculated-mode target's ρ |
| `pathIoLatencyMs` | number | ≥ 0 | downstream I/O wait added to the path (Little's-law input) |

- **`type`**, `variant`, `thickness`, `direction`, `sourceHandle`,
  `targetHandle`: canvas presentation; ignored by the engine.

## Minimal runnable example

```json
{
  "schemaVersion": 1,
  "nodes": [
    { "id": "clients", "data": { "label": "clients", "sim": { "kind": "host", "profile": "client_pool", "requestRatePerSec": 300 } } },
    { "id": "api", "data": { "label": "api", "sim": {
      "kind": "host", "profile": "transactional_api", "configMode": "manual",
      "manualBaselineLatencyMs": 10, "manualSaturationRPS": 500, "manualMaxRPS": 550,
      "overloadBehavior": "collapse", "minReplicas": 1, "maxReplicas": 4,
      "bootDelayMs": 8000, "highWatermark": 0.8, "lowWatermark": 0.3 } } }
  ],
  "edges": [
    { "id": "clients-api", "source": "clients", "target": "api", "data": { "simConfig": {
      "trafficShareRatio": 1, "averagePayloadSizeKB": 2, "targetComputeWeightMultiplier": 1, "pathIoLatencyMs": 0 } } }
  ]
}
```

See [`examples/`](examples/) for four complete topologies.
