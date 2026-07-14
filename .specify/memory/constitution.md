<!--
Sync Impact Report
- Version change: (none, local) → 1.0.0
- Bump rationale: MAJOR — first ratification of a local constitution for the
  sugar engine repository, extracted and adapted from the companion
  diagram-lab / SUGAR constitution (v3.4.1) ahead of the two repos moving
  into separate workspaces. Principles governing the React canvas, Web
  Worker/UI render discipline, and the Vite SPA deployment stay in
  diagram-lab; only the principles that govern this headless engine were
  ported, and their wording was adjusted to drop UI-specific framing
  (e.g. "Inspector" → "formula catalog / CLI output").
- Modified principles: all four carried-over principles reworded to remove
  cross-repo/UI assumptions (see below); numbering compacted from the
  source's I, II, IV, VI to I-IV.
- Added sections: none beyond the standard template sections.
- Removed sections: source Principle III (Open Source & Web-First, Vite SPA
  deploy) and Principle V (Render Discipline: Aggregate, Never Per-Event) —
  both are canvas/UI-only and stay governed by diagram-lab's constitution.
- Templates requiring updates: none (spec-kit templates are generic).
- Follow-up TODOs: none.
-->

# SUGAR Engine Constitution

`sugar` is the headless, dependency-free discrete-event simulation engine
behind SUGAR: it models a software architecture as a graph of hosts, queues,
and edges, runs offered load through it deterministically, and reports where
it saturates — consumable as a library (`src/index.ts`) or the `sugar` CLI.
It implements the simulation principles originated by the companion SUGAR
constitution (canvas/UI concerns remain governed there — see Governance).

## Core Principles

### I. Host-First Model Depth, Closed Parameter Set

Compute is the hard rightsizing problem; queues are connective tissue. The
target users (data engineers, system architects, SREs) already understand
queues — what they cannot eyeball is how hosts interact and where saturation
appears first:

- Host nodes (client pool, transactional API, worker/consumer, database,
  external API) are the deeply modeled components. Their model MUST cover:
  saturation ratio (offered load vs capacity), a smooth ρ/(1−ρ) hockey-stick
  latency curve with no threshold discontinuities, and dual configuration
  modes — manual (known capability curve) and calculated (derived from CPU
  time and worker threads, weighted by inbound edge compute multipliers).
- Queue nodes are deliberately generic: unbounded buffers with **zero
  configuration parameters**, reporting telemetry only (throughput in/out,
  accumulated backlog). Their outflow derives from downstream host capacity.
  No technology-specific queue modeling (Kafka, RabbitMQ, SQS, …) without a
  constitution amendment.
- The user-facing simulation parameter set is **closed** to: host —
  `requestRatePerSec` (client pool) | `manualBaselineLatencyMs`,
  `manualSaturationRPS`, `manualMaxRPS` (manual) | `cpuProcessingTimeMs`,
  `maxWorkerThreads` (calculated) | `minReplicas`, `maxReplicas`,
  `bootDelayMs`, `highWatermark`, `lowWatermark`, `overloadBehavior`
  (transactional_api/worker_consumer/database_server only, either config
  mode); edge — `trafficShareRatio`, `averagePayloadSizeKB`,
  `targetComputeWeightMultiplier`, `pathIoLatencyMs`; queue — none. Adding
  any new user-facing parameter or resource dimension (network bandwidth
  ceilings, disk/IO velocity, RAM/page-cache sizing, hardware instance
  profiles) REQUIRES a constitution amendment. Internal engine tunables in
  `src/config.ts` are exempt but MUST NOT surface as user inputs — this
  explicitly includes the autoscaler's sustain window, cooldown, and the
  visible-replica cap, and the overload-collapse curve's decay steepness and
  collapsed-status goodput threshold. Boot delay and the high/low saturation
  watermarks are user-declared capability parameters, not internal tunables;
  the sustain window and cooldown remain the scaler's own algorithm-policy
  constants. `overloadBehavior` (`'clamp' | 'collapse'`) selects between a
  plateau-and-shed behavior and a retrograde goodput curve past the same
  knee — the curve's shape is derived entirely from the host's existing
  capability parameters plus internal tunables, never a second user-facing
  knob.

Rationale: a lean model users fully understand beats a detailed model they
must trust blindly; parameter bloat is the failure mode that killed the
Kafka-first iteration. Depth now means fidelity of interaction between
hosts, not fidelity of any single vendor technology.

### II. Every Formula Is Traceable

A simulation result users cannot audit is a simulation result users will not
trust:

- Every formula the engine applies MUST be inspectable by its consumers: the
  `run`/`sweep` CLI output and any downstream UI (e.g. the SUGAR canvas)
  MUST be able to surface the active formula(s) and the source(s) they
  derive from (paper, vendor doc, benchmark — a citation, not "trust us").
- Formulas live in the simulation core as named, individually unit-tested
  functions, each carrying its source reference as structured metadata via
  `FormulaDescriptor`/`FormulaSource` (`src/formulaCatalog.ts`), not a code
  comment, so any consumer can render it from data.
- A model change that alters a formula MUST update its source metadata in
  the same change. A formula without a source MUST NOT merge.
- Simulated numbers are positioned as directionally correct for comparing
  scenarios, never as guarantees; CLI/API output and docs MUST NOT claim
  otherwise.

Rationale: traceability is the product's answer to the credibility risk — it
turns "magic number" into "number with a bibliography".

### III. Simulation Core Behind Ports (hexagonal-lite)

The simulation engine MUST stay independent of its delivery mechanisms:

- The engine (event queue, component models, formulas, unit conversion) is
  pure TypeScript: no imports of React, DOM APIs, or any UI framework
  anywhere in the core. `data in → data out`.
- The core is consumed exclusively through explicit ports (TypeScript
  interfaces, `src/ports.ts`): a topology input port, a traffic-source port,
  and a metrics output port. The CLI (`src/cliMain.ts`), the stochastic
  generators, and any external UI are adapters behind those ports.
- Future integrations (new CLI subcommands, a hosted API, editor/agent
  tooling) MUST be implementable as new adapters without modifying the
  core. A change that makes the core aware of a specific adapter is a
  violation.
- Topology source is plain JSON with a documented shape (`SCHEMA.md`); users
  own their models as text. Changes to the serialized shape MUST remain
  backward compatible (old JSON still imports) or ship with a documented
  migration and a `schemaVersion` bump.

Rationale: the same core must serve a CLI, a browser worker, and CI-driven
runs; the boundary is cheap now and prohibitive later.

### IV. Contributor-Legible Codebase

The codebase MUST stay legible to a first-time contributor:

- Small single-purpose modules, one job each. Source files SHOULD stay under
  ~250 lines; a file crossing 300 lines MUST be split by responsibility (or
  the exception justified in the PR).
- No default parameter values — every argument passed explicitly at the call
  site. Behavior MUST NOT depend on an omitted argument.
- TypeScript throughout, dependency-free at runtime; `oxlint` MUST pass
  clean before merge.
- Pure logic — every engine formula, unit conversion, and serialization —
  MUST have unit tests.
- Comments explain constraints the code cannot show, not what the next line
  does.

Rationale: an open-source engine lives or dies by whether outsiders can
confidently change it — doubly so when the code encodes physics formulas.

## Additional Constraints

- **Stack**: TypeScript, dependency-free at runtime (Node.js ESM); `oxlint`
  for linting; Vitest for tests; `tsc` for the published `dist/` build. New
  runtime dependencies require justification in the PR.
- **Public surface**: `src/index.ts` (library) and the `sugar` CLI
  (`src/cliMain.ts`) are the supported entry points. Breaking either, or the
  JSON topology schema (`SCHEMA.md`), before a tagged `1.0.0` MUST be called
  out in the PR description.

## Development Workflow & Quality Gates

- `npx oxlint . --deny-warnings`, `npm run typecheck`, `npm test`, and
  `npm run build` MUST pass before merge — enforced by GitHub Actions CI
  (`.github/workflows/ci-main.yml`, `.github/workflows/ci-dev.yml`) on every
  push and pull request. A red CI blocks merge.
- Model-affecting changes MUST be verified two ways: unit tests on the
  formula functions (exact expected values at known operating points,
  including the saturation region), and a CLI smoke check (`sugar run` /
  `sugar sweep`) confirming the reported formula/source metadata updated.
- Features are specified before implementation via the Spec Kit flow
  (`/speckit-specify` → `/speckit-plan` → `/speckit-tasks` →
  `/speckit-implement`); each plan's Constitution Check gate MUST evaluate
  the change against Principles I-IV.
- Complexity beyond what a principle allows MUST be justified in the plan's
  Complexity Tracking table or removed.
- Any PR to `main` MUST have `dev` as the head branch (see `CLAUDE.md`).

## Governance

- This constitution supersedes ad-hoc practice for the `sugar` engine
  repository. PRs and reviews MUST verify compliance with Principles I-IV;
  violations block merge unless explicitly justified in the feature plan.
- **Relationship to diagram-lab**: this document was extracted from the
  companion SUGAR constitution maintained in
  [diagram-lab/.specify/memory/constitution.md](https://github.com/4xeverburga/chiffonstack-diagram-lab/blob/main/.specify/memory/constitution.md),
  keeping only the principles that govern this headless engine. Canvas/UI
  principles (open-source web deployment shape, render discipline) remain
  governed there. Cross-repo governance follow-ups use the T034 issue
  template (`.github/ISSUE_TEMPLATE/t034-governance-follow-ups.md`). Once
  the repos are split into separate workspaces, this file is the sole
  source of truth for engine-governing principles — it is no longer a
  synced copy.
- **Amendments**: proposed as a PR editing this file, with a Sync Impact
  Report comment. Approval by the project maintainer ratifies the
  amendment. Adding a user-facing simulation parameter or a
  technology-specific queue model requires an amendment to Principle I.
- **Versioning**: semantic — MAJOR for principle removals/redefinitions or
  backward-incompatible governance changes; MINOR for new principles or
  materially expanded guidance (including each new parameter or deeply
  modeled technology admitted past the closed-parameter gate); PATCH for
  clarifications and wording.
- **Compliance review**: the `/speckit-plan` Constitution Check is the
  standing gate; re-check after design (Phase 1) as the plan template
  requires.

**Version**: 1.0.0 | **Ratified**: 2026-07-14 | **Last Amended**: 2026-07-14
