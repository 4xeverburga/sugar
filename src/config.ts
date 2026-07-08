// Centralized tunable parameters for the simulation engine itself
// (CLAUDE.md: "centralize any parameter on a config file"). Every dial
// that shapes simulated behavior lives here in one place instead of
// scattered across engine modules, so tuning any of it means editing
// exactly one file. Presentation/animation tuning (HeatEdge's
// throughput->animation mapping, traffic-scale presets) is NOT engine
// physics and lives in src/lab/animation/trafficScalePresets.ts instead
// (assessment.md A3) — the engine has no notion of "peak" traffic.

// The worker's tick cadence (simWorker.ts) and the engine's metrics
// aggregation window (useSimulation.ts) must always be the same value
// (research.md D5) — previously duplicated as two separately-hand-kept-in-
// sync constants, now a single source of truth.
export const SIM_TICK_MS = 200

// Host/queue/edge simulation model constants (feature 011). Single source
// of truth for every tunable the host saturation curve, queue backlog
// integration, and edge congestion treatment read from (CLAUDE.md).

// ρ is clamped below 1 before it ever reaches the hockey-stick latency
// curve (research.md D2) — division by (1 - rho) would otherwise explode
// to Infinity exactly at saturation, violating the "every emitted number
// is finite" contract (contracts/engine-ports.md guarantee 4).
export const HOST_RHO_CLAMP = 0.99

// A host's status becomes 'saturated' once ρ crosses this fraction of its
// capacity (data-model.md HostNodeMetrics status derivation).
export const HOST_SATURATION_THRESHOLD = 0.85

// An edge is flagged congested once its target host's saturation ratio
// crosses this threshold (data-model.md EdgeSimMetrics.isCongested).
export const EDGE_CONGESTION_THRESHOLD = 0.85

// Floor substituted for a host's own capacity denominator when computing
// ρ if that capacity is configured to exactly zero — keeps ρ a finite
// number (proportional to offered load) instead of dividing by zero,
// without ever producing NaN/Infinity (research.md D2/D6, "zero-capacity
// inputs yield zeros, never NaN").
export const HOST_ZERO_CAPACITY_EPSILON = 1e-6

// RPS <-> MB/s <-> GB/s unit conversions (data-model.md QueueNodeMetrics/
// EdgeSimMetrics), kept centralized rather than re-declared per module.
export const BYTES_PER_KB = 1024
export const KB_PER_MB = 1024
export const MB_PER_GB = 1024

// Autoscaler tunables (feature 013, data-model.md/research.md D1/D2).
// Internal-only per constitution v3.3.0 Principle I — never surfaced as a
// user parameter, unlike minReplicas/maxReplicas/bootDelayMs/highWatermark/
// lowWatermark.

// How long (simulated ms) saturation must stay past a watermark before the
// scaler acts — absorbs brief spikes/dips without flapping (spec.md
// acceptance scenario "no flapping on transients").
export const AUTOSCALE_SUSTAIN_MS = 5000

// Minimum simulated time between two scaling actions on the same host
// (spec FR-007), independent of the sustain window.
export const AUTOSCALE_COOLDOWN_MS = 10000

// Bounded ring size for a host's recent scaling-event history (data-model.md
// ReplicaRuntime.events) — keeps the telemetry payload finite regardless of
// how long a simulation runs.
export const SCALING_EVENT_HISTORY_LIMIT = 10

// Above this many declared replica slots, the scaling-group visual switches
// from discrete per-replica segments to a single proportional-fill bar
// (scalingGroupProjection.ts) — a rendering-legibility threshold only,
// same role the old VISIBLE_REPLICA_CAP served for the vertical chip list
// it replaced. This has NOTHING to do with the scaler's real ceiling:
// nominalCount can never exceed maxReplicas (the autoscaler is already
// bounded by it, see autoscaler.ts), so there is no "overflow" to report —
// only a point past which per-slot ticks would render as unreadable
// slivers in the node's fixed width, so the bar coalesces into a
// proportional reading instead.
export const MAX_DISCRETE_CAPACITY_SEGMENTS = 8

// Bounded ring size for HostSaturationSparkline.tsx's always-on saturation
// gauge (rendered for every saturating-capable host, in every state — see
// that file's header). At SIM_TICK_MS=200ms this is ~6s of trailing
// history: long enough to see a load spike bend the curve over, short
// enough that the sparkline stays legible at node scale.
export const SPARKLINE_HISTORY_LENGTH = 30

// Migration-only fallback (constitution v3.2.0, research.md D5-style
// backward-compat): `bootDelayMs` is now a user-facing capability
// parameter (`HostNodeSim.bootDelayMs`), NOT an internal tunable — this
// constant exists solely so importing a pre-3.2.0 diagram (which predates
// the field entirely) can fill it in explicitly with the value that
// produced its previous behavior, rather than guessing a "reasonable"
// default in a function signature (CLAUDE.md's no-default-parameters rule
// still applies to code; this is a named, documented migration value used
// once at the import call site — see src/lab/exportDiagram.ts).
export const LEGACY_BOOT_DELAY_MS_FOR_IMPORT = 8000

// Migration-only fallbacks (constitution v3.3.0): `highWatermark`/
// `lowWatermark` are now user-facing capability parameters, NOT internal
// tunables — these constants exist solely so importing a pre-3.3.0 diagram
// (which predates the fields) fills them in with the exact values that
// produced its previous behavior (src/lab/exportDiagram.ts), same pattern
// as LEGACY_BOOT_DELAY_MS_FOR_IMPORT above.
export const LEGACY_HIGH_WATERMARK_FOR_IMPORT = 0.8
export const LEGACY_LOW_WATERMARK_FOR_IMPORT = 0.3

// Overload-collapse tunables (feature 012, research.md D2/D5/D6). Internal
// per constitution v3.4.0 Principle I — `overloadBehavior` itself is the
// only new user-facing parameter this feature adds; the curve's steepness
// and the collapsed-status threshold are not surfaced as user inputs.

// Steepness of the retrograde decay past the knee in collapseForwardedRPS
// (research.md D2): decay(overloadRatio) = 1 / (1 + kappa*(overloadRatio-1)^2).
// kappa=2 satisfies SC-001's "<20% of peak by 3x offered load": decay(3) =
// 1/(1+2*4) = 1/9 ~= 11%.
export const HOST_COLLAPSE_DECAY_KAPPA = 2

// A collapse-mode host is reported as 'collapsed' once its forwardedRPS
// falls below this fraction of its knee (kneeRPS) while past the knee
// (research.md D5) — the "materially degraded" goodput threshold.
export const HOST_COLLAPSE_STATUS_RATIO = 0.5

// Migration-only fallback (constitution v3.4.0): `overloadBehavior` is a
// new user-facing capability parameter, not an internal tunable. JSON
// written before this feature has no such field at all — that absence
// fills in 'clamp' explicitly at import time (the exact pre-012 behavior),
// same pattern as LEGACY_BOOT_DELAY_MS_FOR_IMPORT/LEGACY_HIGH_WATERMARK_
// FOR_IMPORT above (src/lab/exportDiagram.ts).
export const LEGACY_OVERLOAD_BEHAVIOR_FOR_IMPORT = 'clamp' as const

// 012-overload-collapse refinement (research.md D9): the displayed/
// telemetry saturationRatio for an elastic collapse host with 0 currently-
// serving replicas ("virtually dead"). A true ratio is meaningless with 0
// capacity (would need HOST_ZERO_CAPACITY_EPSILON-style division, which
// produces an absurd, unreadable percentage like "14000000000%" for any
// realistic incomingRPS) — this fixed sentinel is simply "unambiguously,
// maximally overloaded": comfortably above any realistic highWatermark
// (so the scaler's own watermark logic still treats it as saturated) while
// staying a sane, finite number to render. The host's `status` field
// ('collapsed') is the actual authoritative signal here, not this ratio.
export const HOST_COLLAPSE_DEAD_SATURATION_RATIO = 10

