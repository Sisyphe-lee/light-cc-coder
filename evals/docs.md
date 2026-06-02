# light-cc-coder Eval Plan

This document records the first practical plan for adding an evaluation
environment to `light-cc-coder`.

The goal is not to build a large benchmark platform in this repository. The
first version should be a thin, reproducible evaluation layer around the coder
harness, with official external evaluators doing the heavy lifting where
possible.

## Why This Lives In This Repo First

The evaluation code is tightly coupled to the current CLI, transcript format,
permission model, workspace boundary, and artifact layout. Keeping the first
version in this repository lets us evolve the eval interface together with the
core harness.

We can split evaluation into a separate repository later if it grows into a
shared benchmark service, long-term leaderboard, or multi-agent comparison
platform.

## Evaluation Layers

### 1. Internal Self-Eval

Purpose: catch regressions in the harness itself before running expensive
external benchmarks.

This suite should be small, deterministic, and fast. It should focus on the
hard invariants that make this project useful:

- tool/result pairing is always valid
- permission denial is returned to the model as a tool result
- workspace write boundaries are enforced
- file edits are auditable
- shell failures and truncation are observable
- JSONL transcript can explain and replay a turn
- context compaction does not break the loop
- small real code fixes can be completed end to end

Initial fixture candidates:

- `file-crud`
- `exact-edit`
- `shell-error-feedback`
- `permission-denied`
- `workspace-boundary`
- `tool-result-pairing`
- `transcript-replay`
- `context-compaction`
- `tiny-ts-bugfix`
- `tiny-python-bugfix`

Target command shape:

```bash
bun run eval:self
bun run eval:self --fixture tiny-ts-bugfix
bun run eval:self --model fake
```

### 2. SWE-bench Lite Adapter

Purpose: measure real repository issue-to-patch ability with a public,
credible code repair benchmark.

Pinned baseline:

- package: `swebench==4.1.0`
- dataset: `SWE-bench/SWE-bench_Lite`
- split: `test`
- dataset revision: `69611d31007e1c6731db8bd5b5c3f2d33f5bab6e`

Our adapter should:

1. Load selected SWE-bench Lite instances.
2. Prepare an isolated workspace for each instance.
3. Generate a prompt from the public problem statement and repository state.
4. Run `light-cc-coder` headlessly.
5. Collect `git diff --binary` as `model_patch`.
6. Write official `predictions.jsonl`.
7. Call the official SWE-bench evaluator.
8. Save transcript, patch, logs, and per-instance metrics.

Target command shape:

```bash
bun run eval:swebench --instance sympy__sympy-20590
bun run eval:swebench --limit 5
```

Official evaluator shape:

```bash
python -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Lite \
  --split test \
  --predictions_path .light-cc/evals/<run_id>/swebench/predictions.jsonl \
  --max_workers 4 \
  --run_id <run_id>
```

### 3. Terminal-Bench 2.1 Adapter

Purpose: measure terminal autonomy, command execution, environment handling,
and longer-horizon task completion.

Pinned baseline:

- runner: `harbor==0.13.0`
- dataset: `terminal-bench/terminal-bench-2-1`
- initial attempts: `-k 1`
- leaderboard-aligned attempts later: `-k 5`

Our adapter should be an installed-agent wrapper that runs `light-cc-coder`
inside the task container and saves its transcript and logs.

Target command shape:

```bash
bun run eval:tbench --task openssl-selfsigned-cert
bun run eval:tbench --limit 3
```

Harbor smoke shape:

```bash
harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path eval_agents.light_cc_coder:LightCCCoderAgent \
  -k 1 \
  -t openssl-selfsigned-cert
```

## Proposed Directory Layout

```text
evals/
  docs.md
  lib/
    # Shared eval utilities.
  self/
    fixtures/
      # Small deterministic regression fixtures.
  swebench/
    # SWE-bench Lite adapter.
  terminal-bench/
    # Harbor / Terminal-Bench installed-agent adapter.

.light-cc/evals/
  # Gitignored run outputs.
```

Run outputs should not be committed. They should live under
`.light-cc/evals/<run_id>/`.

## Artifact Contract

Every eval run should produce a machine-readable artifact directory.

```text
.light-cc/evals/<run_id>/
  run.json
  summary.json
  self/
  swebench/
  terminal-bench/
```

Per-task artifacts should include:

- `prompt.md`
- `transcript.jsonl`
- `stdout.log`
- `stderr.log`
- `patch.diff` when a repository was edited
- `metrics.json`

Minimum shared metrics:

- pass/fail or resolved/unresolved
- duration
- turn count
- tool call count
- permission denial count
- changed file count
- diff line count
- transcript validity
- failure reason

## CLI Support Needed

The current CLI already has useful eval-facing flags such as `--cwd`,
`--transcript`, `--max-steps`, and `--permission-mode`.

Likely additions for the eval branch:

- `--prompt-file`
- `--output-json`
- `--quiet`
- `--json-events`
- `--artifact-dir`

These flags should be added before the SWE-bench and Terminal-Bench adapters
depend on them.

## Leakage And Reproducibility Rules

SWE-bench:

- Do not expose gold patches, hidden tests, `FAIL_TO_PASS`, or `PASS_TO_PASS`
  to the agent.
- Keep evaluator logs outside the agent workspace.
- Record dataset name, split, revision, `swebench` version, agent commit, dirty
  state, model, and max steps.

Terminal-Bench:

- Do not modify task resources, verifier logic, or hidden tests.
- Record Harbor version, dataset name, task id, attempt count, model, and agent
  commit.

Self-eval:

- Hidden verification logic should run after the agent finishes.
- Fixture prompts should not reveal exact expected diffs unless that is the
  explicit behavior under test.

## Implementation Phases

### Phase E0: Skeleton And Docs

- Create `evals/` layout.
- Add this plan.
- Keep all run outputs under `.light-cc/evals/`.

Done when the directory structure and plan are committed.

### Phase E1: Headless Eval Interface

- Add `--prompt-file`.
- Add `--output-json`.
- Add `--quiet` or `--json-events`.
- Add `--artifact-dir`.
- Ensure transcripts and summaries are written consistently.

Done when one command can run a headless task in an arbitrary workspace and
produce structured artifacts.

### Phase E2: Internal Self-Eval

- Implement the fixture runner.
- Add the first 8-10 fixtures.
- Add transcript and tool-result validators.
- Support fake-provider deterministic runs.

Done when `bun run eval:self` gives a stable pass/fail summary.

### Phase E3: SWE-bench Lite Smoke

- Add SWE-bench adapter.
- Validate official evaluator with a gold single-instance smoke.
- Run one agent instance and produce valid `predictions.jsonl`.
- Run a 5-instance smoke batch.

Done when we have resolved-rate output plus per-instance artifacts.

### Phase E4: Terminal-Bench 2.1 Smoke

- Add Harbor installed-agent wrapper.
- Run Harbor oracle on one task.
- Run `light-cc-coder` on one task.
- Run a 3-task smoke batch.

Done when pass/fail and logs are collected in the common artifact format.

### Phase E5: Unified Report

- Generate `summary.json` across self-eval, SWE-bench, and Terminal-Bench.
- Classify common failure modes.
- Record versions, commit, dirty state, model, and cost/tokens where available.

Done when a single run directory can explain what was evaluated, with which
versions, and why tasks passed or failed.

## Near-Term Recommendation

Build in this order:

1. E1 headless eval interface.
2. E2 internal self-eval.
3. E3 SWE-bench Lite smoke.
4. E4 Terminal-Bench 2.1 smoke.
5. E5 unified reporting.

This keeps the feedback loop cheap while still aligning the project with public
benchmarks used by current coding agents and model labs.
