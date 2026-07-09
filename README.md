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
	<img src="https://img.shields.io/badge/tests-156%20passing-brightgreen" alt="Tests"/>
</p>

---

## Table of Contents

- [What is sugar?](#what-is-sugar)
- [Status](#status)
- [Install](#install)
- [Develop](#develop)
- [License](#license)

## What is sugar?

Headless, dependency-free discrete-event simulation engine for **SUGAR** 


## Status

Early extraction (pre-v0.1). The public API surface (`src/index.ts`) and the
JSON topology schema it accepts are not yet stable — expect breaking changes
before a tagged `1.0.0`. Shipped as TypeScript source (no build step yet);
consuming this package today means consuming it from another TypeScript
project via a bundler, not as a plain Node `require()`.

## Install

```bash
npm install @4xeverburga/sugar-skills
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
