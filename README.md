<div align="center">
	<img src="./media/logo.png" alt="SUGAR logo" width="200" height="200"/>
	<!-- TODO: replace with real logo -->
	<h1>SUGAR</h1>
	<h3><em>Headless discrete-event simulation for software architectures under load.</em></h3>
</div>

<p align="center">
	<strong>The dependency-free engine behind SUGAR — predicts throughput, backlog, saturation, and collapse before you provision real infrastructure.</strong>
</p>

<p align="center">
	<img src="https://img.shields.io/badge/status-pre--v0.1-orange" alt="Status"/>
	<img src="https://img.shields.io/badge/license-MIT-blue" alt="License"/>
	<img src="https://img.shields.io/badge/tests-198%20passing-brightgreen" alt="Tests"/>
</p>

---

## Table of Contents

- [What is sugar?](#what-is-sugar)
- [CLI](#cli)
- [Agent skill](#agent-skill)
- [Status](#status)
- [Governance](#governance)
- [Install](#install)
- [Develop](#develop)
- [License](#license)

## What is sugar?

Headless, dependency-free discrete-event simulation engine for **SUGAR**. It
models a software architecture as a graph of hosts, queues, and edges, runs
offered load through it deterministically, and reports where it saturates —
no infrastructure required. Usable as a library (public API in
[`src/index.ts`](src/index.ts)) or through the `sugar` CLI below.

The topology it reads/writes is the JSON the SUGAR canvas exports; the format
contract is in [SCHEMA.md](SCHEMA.md).

Internally, behavior dispatch is registry-driven via `src/registry/`: each
model encapsulates config validation, state lifecycle, and per-window compute
hooks while the propagation loop remains a generic DAG driver.

**See it live:** open any `diagram.json` in the hosted SUGAR canvas at
**[sugar.kekeros.com](https://sugar.kekeros.com)** — drag the file onto the
canvas (or use *Upload JSON*) and watch the topology saturate.

## CLI

```bash
# Simulate a topology and print a steady-state + bottleneck summary
sugar run examples/checkout-system.json --duration 120s

# Binary-search the breaking point of one parameter
sugar sweep examples/checkout-system.json \
  --param web-client.requestRatePerSec --from 150 --to 8000
```

`run` prints an agent-readable summary (per-node status/ρ/latency/RPS, the
first-saturation order, the bottleneck, autoscaling activity); add `--json` for
a machine-readable object or `--raw` for every metrics window. `sweep` reports
the largest load that holds, the smallest that breaks, and which node gives out
first. Read a topology from a file path or `-` for stdin. Four ready-to-run
topologies live in [`examples/`](examples/).

## Agent skill

SUGAR ships as an [Agent Skill](SKILL.md) — install it into any compatible
harness (Claude Code, Codex CLI, Gemini CLI, Cursor, …) with the ecosystem CLI:

```bash
npx sugar-skills install
```

By default this now performs two steps:

1. Installs skill metadata via `npx skills add <source>`
2. Installs the SUGAR runtime into `.sugar/` via npm

That gives you an isolated project-local runtime at:

```bash
.sugar/node_modules/.bin/sugar
```

Installer output includes the SUGAR acronym:

```text
	_____ _    _  _____          _____
 / ____| |  | |/ ____|   /\   |  __ \
| (___ | |  | | |  __   /  \  | |__) |
 \___ \| |  | | | |_ | / /\ \ |  _  /
 ____) | |__| | |__| |/ ____ \| | \ \
|_____/ \____/ \_____/_/    \_\_|  \_\

SUGAR =
	Simulation
	Utility
	Generally
	Available for
	Runtime Systems
```

If you want to target a different source explicitly:

```bash
npx sugar-skills install owner/repo
```

Useful options:

```bash
npx sugar-skills install --no-runtime
npx sugar-skills install --runtime-dir .my-sugar-runtime
```

Equivalent direct commands:

```bash
npx skills add owner/repo
npm install --prefix .sugar --no-save sugar-skills@<version>
```

The agent can then author a topology from a described system, run it, and
binary-search its breaking point to answer "will this hold at N×, and where
does it break first?".

## Status

Early extraction (pre-v0.1). The public API surface (`src/index.ts`) and the
JSON topology schema (`schemaVersion` 1, see [SCHEMA.md](SCHEMA.md)) are not yet
frozen — expect breaking changes before a tagged `1.0.0`. Ships with an
ESM-correct `dist/` build (`tsc`), consumable as a plain Node ESM import or via
a bundler.

## Governance

The governing simulation principles (constitution) are maintained in the
companion spec repository:

- [diagram-lab/.specify/memory/constitution.md](https://github.com/4xeverburga/chiffonstack-diagram-lab/blob/main/.specify/memory/constitution.md)

This `sugar` engine repository implements those principles; cross-repo
governance follow-ups are tracked with the T034 issue template in
`.github/ISSUE_TEMPLATE/t034-governance-follow-ups.md`.

## Install

```bash
npm install sugar-skills      # library + `sugar` CLI (via npx / bin)
```

Still pre-v0.1 — pin an exact version rather than a caret range until the
public API and JSON topology schema stabilize.

## Develop

```bash
npm install
npm test        # vitest
npm run typecheck
```

## License

MIT — see [LICENSE](LICENSE).
