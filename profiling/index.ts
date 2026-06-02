// Public entry for the local profiling report tool. light-cc-coder is the first
// producer of profile.span events; this reducer/report layer is deliberately
// decoupled from the runtime so other harnesses emitting compatible bounded spans
// can reuse it. See ./README.md.

export { summarizeProfile, type AnyEvent, type SummarizeOptions } from "./report/summarize"
export { renderText } from "./report/renderText"
export { renderJson } from "./report/renderJson"
export { PROFILE_REPORT_SCHEMA_VERSION, type ProfileReport } from "./report/types"
export { validateAgainstSchema } from "./schema/validateReport"
export {
  compareReports,
  renderComparison,
  DEFAULT_COMPARE_THRESHOLDS,
  DEFAULT_DURATION_THRESHOLD,
  DEFAULT_NOISY_THRESHOLD,
  DEFAULT_TOKEN_GROWTH_THRESHOLD,
  type CompareReportsInput,
  type CompareThresholds,
  type CompareThresholdsInput,
  type ComparisonCheck,
  type DurationThreshold,
  type ProfileComparison,
  type TokenGrowthThreshold,
} from "./compareReports"
