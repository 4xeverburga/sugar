# sugar-engine

Headless, dependency-free discrete-event simulation engine for **SUGAR** —
predicts throughput, backlog, saturation, and collapse for a modeled software
architecture under load. Extracted from
[diagram-lab](https://github.com/4xeverburga/chiffonstack-diagram-lab), which
hosts SUGAR's canvas UI.

The engine has no dependency on React, the DOM, or any UI framework — it runs
identically in a browser Web Worker, Node, or a future CLI runner. See
`src/index.ts` for the supported public API; everything else in `src/` is an
internal implementation detail that may change without notice.

## Status

Early extraction (pre-v0.1). The public API surface (`src/index.ts`) and the
JSON topology schema it accepts are not yet stable — expect breaking changes
before a tagged `1.0.0`. Shipped as TypeScript source (no build step yet);
consuming this package today means consuming it from another TypeScript
project via a bundler, not as a plain Node `require()`.

## Install

Not yet published to npm. For now, consume via a workspace/`file:` dependency
or a git dependency pointing at this repo.

## Develop

```bash
npm install
npm test        # vitest
npm run typecheck
```

## License

MIT — see [LICENSE](LICENSE).
