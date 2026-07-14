---
name: sugar
description: Simulate a software architecture's capacity and find where it breaks — without deploying anything. Use when asked whether a system (API tier, worker pool, queue, database, microservice graph) will hold at some load, where the bottleneck is, what saturates first, how far it scales before collapsing, or "will this handle N× traffic?". Runs a deterministic discrete-event queueing simulation over a topology of hosts, queues, and edges, and can binary-search the breaking point of any parameter. Trigger on capacity planning, load/scaling/bottleneck/saturation questions, "will it hold", "where does it break", back-of-the-envelope throughput reasoning, and reviewing an architecture diagram for overload risk.
---

# SUGAR capacity simulation

SUGAR models a system as a graph of **hosts** (compute), **queues** (buffers),
and **edges** (traffic between them), then simulates offered load through it and
reports where it saturates. It is deterministic (seeded), needs no deployment,
and runs entirely locally via the `sugar` CLI.

Use it to answer capacity questions before writing infra code: *will this tier
hold at 3× traffic? which node saturates first? how many replicas does the
worker pool need? where does the whole system collapse?*

## When to use this

- "Will this architecture hold at N requests/sec?" / "…at 10× today's load?"
- "Where is the bottleneck?" / "What saturates first?"
- "How far can I scale this before it breaks?"
- Reviewing an architecture diagram or design doc for overload risk.
- Sizing an autoscaling range (min/max replicas) or a queue-backed worker pool.

If the user has a SUGAR diagram export (`diagram.json`), run it directly. If
they describe a system in prose, author a topology JSON from their description
(see the schema), then run it.

## Workflow

### 1. Get a topology

Either use an existing `diagram.json` (the format the SUGAR canvas exports), or
author one. The full contract is in [SCHEMA.md](SCHEMA.md); the short version:

- Every runnable topology needs at least one **`client_pool`** host — the
  traffic source (`requestRatePerSec`).
- **Compute hosts** (`transactional_api`, `worker_consumer`, `database_server`)
  are configured `manual` (you state the knee: `manualSaturationRPS`) or
  `calculated` (from `cpuProcessingTimeMs` and `maxWorkerThreads`), with an
  autoscaling range (`minReplicas`/`maxReplicas`) and an `overloadBehavior`
  (`clamp` = hard-cap, `collapse` = goodput decays past the knee).
- **`external_api`** hosts are bottomless fixed-latency dependencies.
- **`queue`** nodes (`{ "kind": "queue" }`) buffer flow to a consumer.
- **Edges** carry a `simConfig`: `trafficShareRatio` (fan-out fraction, not
  normalized), `averagePayloadSizeKB`, `targetComputeWeightMultiplier`,
  `pathIoLatencyMs`.

Start from a file in [`examples/`](examples/) and adapt it — that's faster and
less error-prone than writing one from scratch.

### 2. Run it

```
sugar run <diagram.json> --duration 120s
```

The default output is an agent-readable summary: steady-state status, ρ
(saturation), latency, and RPS per node; the first-saturation order; the
bottleneck; and any autoscaling activity. Give the simulation enough time for
autoscaling to settle — 120s of simulated time is a good default (boot delays
and cooldowns are on the order of seconds).

Flags: `--seed <n>` (reproducibility, default 42), `--window <ms>` (aggregation
granularity), `--json` (machine-readable summary), `--raw` (every window, large
— only for tooling).

### 3. Find the breaking point

To answer "how far can it go?", binary-search one parameter:

```
sugar sweep <diagram.json> --param web-client.requestRatePerSec --from 150 --to 8000
```

`--param` is `<nodeId>.<field>` — usually the client pool's `requestRatePerSec`,
but any numeric sim field works (e.g. a host's `maxReplicas`). The sweep reports
the largest value that holds, the smallest that breaks, and which node gives out
first. "Holds" means no host is shedding/collapsing and no queue backlog is
growing unbounded.

### 4. Interpret and report

- **`status`**: `healthy` → `saturated` (ρ high but still serving every
  request) → `overloaded` (shedding load) → `collapsed` (goodput has fallen
  apart). `saturated` is a warning; `overloaded`/`collapsed` is a failure.
- **First-saturation order** answers "what breaks first" — the top entry is the
  bottleneck to fix.
- **`shedRPS` > 0** means requests are being dropped. A growing queue backlog
  (`+GB/s`) means consumers can't keep up.
- Translate findings into an action: add replicas, raise the knee, add a queue,
  or fan out load. Then re-run to confirm the fix holds.

### 5. (Optional) Show it, don't just tell it

The answer above is complete from `sugar run`'s text alone — no browser needed.
But to let the user *see* the topology saturate, open the same `diagram.json`
in the hosted SUGAR canvas: **https://sugar.kekeros.com**. Drag the file onto
the canvas (or use **Upload JSON**), then press play.

If your harness has a browser tool (e.g. Playwright MCP), you can do this
autonomously:

1. `browser_navigate` to `https://sugar.kekeros.com`
2. `browser_file_upload` the `diagram.json` onto the page's `<input type="file">`
3. wait for `[data-testid="diagram-status"]` to report `data-diagram-source="file"`
4. press play, then `browser_take_screenshot`

Skip this section entirely if no browser tool is available — it's the visual
proof, not the analysis.

## Install

Installable into any Agent Skills-compatible harness (Claude Code, Codex CLI,
Gemini CLI, Cursor, ...) via the installer CLI:

```
npx sugar-skills install
```

This installs skill metadata and also installs the SUGAR runtime into `.sugar/`
by default.

You can still install only the skill metadata via the ecosystem CLI:

```
npx skills add 4xeverburga/sugar
```

The CLI it drives is the `sugar-skills` npm package:

```
npm install -g sugar-skills   # provides the `sugar` command
```
