// Optional Stage 2 live N-run profiling tool (Regime B). This entry exposes the
// pure aggregate, the human renderer, the named live scenarios, and the runner
// orchestration. Nothing here is imported by src/ or required for a normal run;
// it is a separate, optional developer dogfood surface (spec/phase-8-stage-2.md).

export {
  aggregateLiveRuns,
  computeStats,
  LIVE_RUNS_SUMMARY_SCHEMA_VERSION,
  type CategoryStat,
  type CompactAggregate,
  type ContextAggregate,
  type LiveRunConfigEcho,
  type LiveRunEntry,
  type LiveRunRecord,
  type LiveRunStatus,
  type LiveRunsAggregateInput,
  type LiveRunsSummary,
  type ProviderAggregate,
  type RuntimeAggregate,
  type Stats,
  type ToolAggregate,
  type TranscriptWriteAggregate,
} from "./aggregate"
export { renderLiveRunsSummary } from "./renderSummary"
export { LIVE_SCENARIOS, resolveScenario, scenarioNames, type LiveScenario } from "./scenarios"
export { main, parseLiveRunArgs, runLive, usage, type LiveRunOptions } from "./runner"
