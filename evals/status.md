# Eval Status

Current branch: `codex/eval-harness-plan`

Last updated: 2026-06-02

## Phase Status

| Phase | Status | Notes |
|---|---|---|
| E0: Skeleton and docs | Done | `evals/` structure and English/Chinese plans are in place. |
| E1: Headless eval interface | Implemented and target-verified | CLI flags and artifact summaries are implemented in `src/cli/main.ts`; E1 CLI tests and typecheck passed locally after installing Bun. |
| E2: Internal self-eval | Implemented and target-verified | Fake-provider runner and 10 deterministic fixtures are in place under `evals/self/`; core harness invariants are covered. |
| E3: SWE-bench Lite adapter | Agent smoke + usage verified; batch evaluator partially verified | Thin runner is in place under `evals/swebench/`; offline dry-run, prompt leak checks, prediction format, preflight, official gold single-instance evaluator smoke, one DeepSeek agent smoke, 3-instance agent patch generation, and one Astropy official evaluator check passed. |
| E4: Terminal-Bench 2.1 adapter | Small-batch smoke completed | Thin Harbor command/artifact adapter and installed-agent wrapper are in place; offline dry-run, preflight, tests, typecheck, one passing single-task smoke, and one 3-task representative smoke completed on `4090_local`. |
| E5: Unified report | Not started | Depends on E2-E4 artifacts. |

## E1 Implemented Surface

CLI flags added:

- `--prompt-file`
- `--artifact-dir`
- `--output-json`
- `--quiet`
- `--json-events`

Artifact files written under `--artifact-dir`:

- `run.json`
- `summary.json`
- `transcript.jsonl` by default, unless `--transcript` is explicitly set
- `stdout.log`
- `stderr.log`

Summary fields currently include:

- status and exit code
- start/end timestamps and duration
- cwd, session id, run id
- prompt source and prompt file path
- transcript and artifact paths
- key run options
- event counts by type
- tool call/result/error counts
- permission/approval/bash/error counts
- turn end reasons

## Verification Status

Attempted commands:

```bash
PATH=/Users/sjx/.bun/bin:$PATH bun --version
PATH=/Users/sjx/.bun/bin:$PATH bun install --frozen-lockfile
PATH=/Users/sjx/.bun/bin:$PATH bun test test/cli/phase1-cli.test.ts
PATH=/Users/sjx/.bun/bin:$PATH bun run typecheck
bun run test
git diff --check
```

Results:

- Bun installed successfully at `/Users/sjx/.bun/bin/bun`; version `1.3.14`.
- `bun install --frozen-lockfile` passed after using the local `7890` proxy.
- `bun test test/cli/phase1-cli.test.ts` passed: 10 pass, 0 fail.
- `bun run typecheck` passed.
- `git diff --check` passed.
- Full `bun run test` executed, and the E1 CLI tests passed inside it.
- Full `bun run test` still has 7 failures outside the E1 change surface:
  - 2 workspace path tests expecting `/var/...` while this environment resolves `/private/var/...`.
  - 2 runtime cwd tests with the same `/var` vs `/private/var` mismatch.
  - 1 runtime timeout partial-output assertion.
  - 2 CLI approval tests where `server.listen(0, "127.0.0.1")` failed to start.

## Added Test Coverage

The CLI test file now includes coverage for:

- `--prompt-file`
- `-p` and `--prompt-file` mutual exclusion
- `--artifact-dir` default artifact contract
- `--output-json`
- `--quiet`
- `--json-events`
- numeric option validation
- provider-config failure summary artifacts

These tests passed locally after Bun was installed.

## Known Follow-Ups

- Decide whether E1 should add an explicit `--approval-mode auto-deny|auto-allow|prompt` before E2, or defer it until Terminal-Bench integration.
- Consider whether `--artifact-dir` should warn when it is inside `--cwd`; this is useful for local runs, but formal benchmark runs should keep artifacts outside the agent workspace.
- Investigate the 7 remaining full-suite failures separately; they appear unrelated to the E1 CLI artifact changes.

## E2 Current Surface

Initial command:

```bash
bun run eval:self
bun run eval:self -- --fixture file-crud
bun run eval:self -- --list
```

Deterministic fixtures:

- `context-compaction`
- `exact-edit`
- `file-crud`
- `permission-denied`
- `shell-error-feedback`
- `tiny-python-bugfix`
- `tiny-ts-bugfix`
- `tool-result-pairing`
- `transcript-replay`
- `workspace-boundary`

The first runner version uses `AgentSession`, `FakeProvider`, `RealToolRuntime`,
`WorkspaceFs`, and `LocalRuntime` directly. It writes reports to
`.light-cc/evals/<run_id>/self/` and validates:

- expected fixture files
- tool call/result counts
- tool error counts
- permission denial counts
- bash observation counts
- compact event counts
- transcript replay validity
- strict tool/result pairing by step, id, name, and order

E2 verification:

```bash
PATH=/Users/sjx/.bun/bin:$PATH bun run eval:self
PATH=/Users/sjx/.bun/bin:$PATH bun run eval:self -- --fixture context-compaction --run-id self-smoke-context
PATH=/Users/sjx/.bun/bin:$PATH bun run eval:self -- --fixture file-crud --run-id self-smoke-file-crud
PATH=/Users/sjx/.bun/bin:$PATH bun run eval:self -- --list
PATH=/Users/sjx/.bun/bin:$PATH bun run typecheck
```

Results:

- `bun run eval:self` passed: 10 pass, 0 fail.
- `bun run eval:self -- --fixture context-compaction --run-id self-smoke-context` passed.
- `bun run eval:self -- --fixture file-crud --run-id self-smoke-file-crud` passed.
- `bun run eval:self -- --list` lists all 10 fixtures.
- `bun run typecheck` passed after adding `evals/**/*.ts` to `tsconfig.json`.
- `evals/self/README.zh-CN.md` documents each fixture, PASS/FAIL meaning, and artifact reading workflow.

## E3 Current Surface

Command:

```bash
bun run eval:swebench -- --instances-file evals/swebench/fixtures/sample-instance.json --dry-run
bun run eval:swebench -- --instance sympy__sympy-20590 --dry-run
bun run eval:swebench -- --instance sympy__sympy-20590 --run-agent --max-steps 80
bun run eval:swebench -- --gold --evaluate --instance sympy__sympy-20590 --max-workers 1
bun run eval:swebench -- --preflight
```

Implemented files:

- `evals/swebench/run.ts`
- `evals/swebench/types.ts`
- `evals/swebench/prompt.ts`
- `evals/swebench/load_instances.py`
- `evals/swebench/README.zh-CN.md`
- `test/evals/swebench-adapter.test.ts`

Adapter responsibilities now implemented:

- Load local safe instances, JSON/JSONL records, plain instance-id lists, or pinned Hugging Face dataset instances through the Python helper.
- Strip hidden SWE-bench fields before writing prompts or per-instance artifacts.
- Generate per-instance `prompt.md`, `instance.json`, `metrics.json`, and `patch.diff`.
- Optionally prepare a shallow base-commit workspace, call `light-cc-coder`, collect `git diff --binary --no-ext-diff HEAD`, and write official `predictions.jsonl`.
- Optionally call `python -m swebench.harness.run_evaluation`.
- Record provider streaming usage from agent transcripts and summarize token/cost estimates in per-instance `metrics.json` and run `summary.json`.
- Run local environment preflight checks for Python, `swebench`, `datasets`, Docker CLI/daemon, disk space, and Mac ARM notes.
- Pass `--namespace <value>` through to the official evaluator for Mac ARM troubleshooting.
- Refuse accidental expensive runs over more than 5 instances unless `--allow-large-run` is set.

E3 verification:

```bash
PATH=/Users/sjx/.bun/bin:$PATH bun test test/evals/swebench-adapter.test.ts
PATH=/Users/sjx/.bun/bin:$PATH bun run eval:swebench -- --instances-file evals/swebench/fixtures/sample-instance.json --dry-run --run-id swebench-dry-smoke-3
PATH=/Users/sjx/.bun/bin:$PATH bun run eval:swebench -- --preflight --run-id swebench-preflight-local
PATH=/Users/sjx/.bun/bin:$PATH bun run typecheck
```

Results:

- SWE-bench adapter tests passed: 3 pass, 0 fail.
- Offline dry-run passed and wrote `.light-cc/evals/swebench-dry-smoke-3/swebench/`.
- Local preflight ran and correctly failed on external environment blockers:
  - `swebench==4.1.0` is not installed.
  - Docker daemon is not running.
  - Disk space is about 26GiB free, below the 120GB SWE-bench recommendation.
- `bun run typecheck` passed.
- Remote gold smoke passed at `.light-cc/evals/gold-smoke-sympy-20590/swebench/`:
  - `mode.gold=true`
  - `mode.evaluate=true`
  - `mode.runAgent=false`
  - evaluator exit code `0`
  - official stdout: submitted `1`, completed `1`, resolved `1`, errors `0`
- Remote DeepSeek provider setup passed on `4090_local`:
  - `LIGHT_CC_BASE_URL=https://api.deepseek.com`
  - `LIGHT_CC_MODEL=deepseek-v4-pro`
  - `LIGHT_CC_API_KEY_ENV=DEEPSEEK_API_KEY`
  - `lightcc doctor --cwd "$PWD"` passed with `rg` available.
- Remote minimal DeepSeek chat smoke passed: prompt `Reply with exactly: pong` returned `pong`.
- Remote `lightcc` one-shot smoke passed: read-only, max steps 1, no tool calls, assistant returned `pong`.
- Remote single SWE-bench agent smoke passed:
  - instance: `sympy__sympy-20590`
  - run id: `agent-smoke-sympy-20590-deepseek-v4-pro-explicit`
  - agent completed with non-empty patch
  - official evaluator resolved `1/1`
  - changed file: `sympy/core/_print_helpers.py`
- Remote usage capture smoke passed:
  - `deepseek-usage-one-shot-smoke` wrote actual `inputTokens`, `outputTokens`, cache hit/miss, and reasoning tokens into `assistant.message.usage`.
- Remote 3-instance SWE-bench agent batch generated patches and usage:
  - run id: `batch3-swebench-lite-deepseek-v4-pro-usage`
  - instances: `astropy__astropy-12907`, `astropy__astropy-14182`, `astropy__astropy-14365`
  - agent completed `3/3`, empty patches `0`
  - usage: 118 requests, 3,006,426 input tokens, 34,997 output tokens, 2,814,976 cache-hit input tokens, 191,450 cache-miss input tokens, 15,885 reasoning tokens
  - estimated DeepSeek cost: `$0.12393243`
  - official evaluator was stopped after a long pre-container stall; agent patches and predictions are preserved under `.light-cc/evals/batch3-swebench-lite-deepseek-v4-pro-usage/swebench/`.
- Remote single Astropy official evaluator follow-up passed:
  - run id: `eval-verify-astropy-12907-bg`
  - instance: `astropy__astropy-12907`
  - prediction source: preserved 3-instance batch predictions
  - official report: `resolved: true`, `patch_successfully_applied: true`, related tests passed
  - no additional model API calls were made for this evaluator-only check.
- Remote latest `main` merge and sandbox install passed:
  - merged through `fdc07e5 Simplify sandbox runtime installation`
  - installed user-level Node/npm and ran `bash ./install.sh --package . --sandbox-mode required`
  - installed `@anthropic-ai/sandbox-runtime@0.0.52`
  - `lightcc doctor --sandbox --os-sandbox required` reports package/backend dependencies ready
  - default strong Linux seccomp path still fails on this Ubuntu 26.04 host with `apply-seccomp: write /proc/self/setgroups ... Permission denied`
  - explicit settings with `network.allowAllUnixSockets=true` pass the real filesystem isolation E2E: workspace write allowed, HOME write denied
  - temporary AppArmor sysctl changes were restored to their original restrictive values after validation
- Remote post-merge validation passed:
  - `bun test test/runtime/phase9-sandbox-runtime.test.ts`: 19 pass, 0 fail
  - `bun test test/providers/openaiCompatible.test.ts test/evals/swebench-adapter.test.ts`: 8 pass, 0 fail
  - `bun test test/cli/phase1-cli.test.ts test/cli/phase7-product-shell.test.ts`: 29 pass, 0 fail
  - `bun run typecheck` passed
  - `bun run eval:self` passed: 10 pass, 0 fail
  - SWE-bench sample dry-run passed with run id `sandbox-post-merge-dry`

Remaining E3 external validation:

- Re-run official evaluator on the remaining 2 preserved Astropy predictions, preferably one instance at a time, before treating the batch resolved rate as meaningful.
- `eval-verify-astropy-14182-bg` and `eval-verify-astropy-14365-bg` are still alive as evaluator-only background processes, but both were still at `PREP ...` with no Docker containers and no official reports at the last check.
- Decide whether future SWE-bench adapter runs should pass `--os-sandbox off` explicitly, because the official evaluator already isolates tests in Docker and the new optional OS sandbox may add another variable.
- For agent-side sandbox on `4090_local`, use an explicit settings file with `network.allowAllUnixSockets=true` unless the host's nested user namespace/seccomp behavior is fixed at the OS level.

## E4 Current Surface

Command:

```bash
bun run eval:tbench -- --task terminal-bench/break-filter-js-from-html --dry-run
bun run eval:tbench -- --tasks-file tasks.txt --dry-run
bun run eval:tbench -- --preflight
bun run eval:tbench -- --task terminal-bench/break-filter-js-from-html --run --attempts 1
```

Implemented files:

- `evals/terminal-bench/run.ts`
- `evals/terminal-bench/types.ts`
- `evals/terminal-bench/README.zh-CN.md`
- `evals/terminal_bench/agent.py`
- `evals/terminal_bench/__init__.py`
- `test/evals/terminal-bench-adapter.test.ts`

Initial adapter responsibilities:

- Build a reproducible Harbor command for Terminal-Bench 2.1.
- Bind Harbor job names to the eval `runId`.
- Default to dry-run and refuse accidental full-split runs.
- Support `--task`, `--tasks-file`, `--limit`, `--attempts`, `--run`, and `--preflight`.
- Write `run.json`, `summary.json`, `harbor-command.json`, `selected_tasks.jsonl`, and per-task `task.json`/`prompt.md`/`metrics.json`.
- Parse Harbor `jobs/<runId>/result.json` into wrapper `summary.json` after real runs.
- Provide a Harbor `BaseInstalledAgent` wrapper that installs and runs `lightcc` headlessly inside the task container.
- Pass `--model` through both Harbor metadata and container-side `LIGHT_CC_MODEL`.
- Support `source:<path>` package specs plus explicit container mounts, so smoke runs can evaluate the current unpublished branch.
- Pass provider hosts to Harbor `--allow-agent-host`, inferred from `--base-url` by default.
- Merge repeated `--mounts` inputs into the single JSON array that Harbor expects.
- Support `--agent-env-file <container-path>` so API keys can be passed through a mounted env file instead of Docker Compose `-e KEY=value` process arguments.

Current Harbor command shape:

```bash
harbor run \
  -d terminal-bench/terminal-bench-2-1 \
  --agent-import-path evals.terminal_bench.agent:LightCCCoderAgent \
  -k 1 \
  --jobs-dir .light-cc/evals/<run_id>/terminal-bench/jobs \
  --job-name <run_id> \
  -i terminal-bench/break-filter-js-from-html
```

E4 verification:

```bash
bun test test/evals/terminal-bench-adapter.test.ts
bun run eval:tbench -- --task terminal-bench/break-filter-js-from-html --dry-run --run-id tbench-dry-smoke
bun run eval:tbench -- --limit 2 --dry-run --run-id tbench-limit-dry
bun run eval:tbench -- --preflight --run-id tbench-preflight-harbor --harbor /home/sjx/.venvs/light-cc-harbor/bin/harbor
bun run typecheck
```

Results:

- Terminal-Bench adapter tests passed: 4 pass, 0 fail.
- Dry-run single-task artifact contract passed.
- Dry-run limit command uses Harbor `-l 2`, matching `harbor==0.13.0`.
- Installed `harbor==0.13.0` in `/home/sjx/.venvs/light-cc-harbor` with Python 3.14.
- Harbor preflight passed with Docker CLI/daemon available and the custom agent import path actually importable through the Harbor venv Python.
- Dry-run command now includes `--job-name <runId>` and mirrors `--model` into `LIGHT_CC_MODEL`.
- Current-branch smoke support was added through `--mounts`, `--agent-package-spec source:/opt/light-cc-coder`, and `--agent-node-dir /opt/lightcc-node`.
- DeepSeek smoke command will pass `--allow-agent-host api.deepseek.com` through the inferred `--base-url`.
- User-level Docker Compose v2 plugin is required and is checked by preflight.
- Typecheck passed after adding the E4 TypeScript files.
- Added verifier/network stability controls:
  - `--verifier-env KEY=VALUE` passes Harbor verifier environment variables.
  - `--verifier-proxy <url>` expands to verifier `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`.
  - `--extra-docker-compose <path>` passes Harbor Compose overlays.
  - `evals/terminal-bench/docker-compose.host-network.yml` lets Docker containers reach a proxy bound to host loopback.
  - Harbor timeout multipliers such as `--agent-timeout-multiplier` are now exposed by the adapter.
- Real Harbor smoke attempts:
  - `tbench-smoke-openssl-deepseek-current`: failed before dataset resolution because Harbor inherited `ALL_PROXY=socks5://...` but its httpx install lacked `socksio`; no agent/model call.
  - `tbench-smoke-openssl-deepseek-current-v2`: failed before agent/model because `openssl-selfsigned-cert` is not in `terminal-bench/terminal-bench-2-1`.
  - `tbench-smoke-break-filter-js-deepseek-current-v3`: resolved the dataset task and created a Harbor trial, but failed during Docker environment setup before agent/model execution because `docker compose` is missing on `4090_local`.
  - Installed user-level Docker Compose v2 plugin at `~/.docker/cli-plugins/docker-compose`; preflight now reports `Docker Compose version 2.40.3+ds1-0ubuntu1`.
  - `tbench-smoke-break-filter-js-deepseek-current-v5`: completed end-to-end on `terminal-bench/break-filter-js-from-html`; Harbor reported `n_completed_trials=1`, `n_errors=0`, `mean reward=1.0`.
  - v5 agent usage from `transcript.jsonl`: 12 requests, 92,792 input tokens, 5,974 output tokens, 87,296 cache-hit input tokens, 5,496 cache-miss input tokens, 4,002 reasoning tokens; estimated DeepSeek cost with the existing pricing table is about `$0.00790459`.
  - v5 runtime: environment setup about 52s, agent setup about 0.3s, agent execution about 149s, verifier about 748s.
  - v5 artifacts were checked for `sk-` key-pattern leakage after moving API keys out of the command string; no matching files remained.
  - `tbench-smoke-break-filter-js-deepseek-current-v6-proxy`: verifier proxy + host-network overlay fixed the prior `uv` GitHub download flake; verifier reward was `1.0`, but Harbor still recorded `AgentTimeoutError` because the agent phase hit the default 1200s timeout.
  - `tbench-smoke-break-filter-js-deepseek-current-v7-proxy-timeout`: completed cleanly with verifier proxy + host-network overlay + `--agent-timeout-multiplier 2`; Harbor reported `n_completed_trials=1`, `n_errors=0`, `mean reward=1.0`.
  - v7 agent usage: 14 requests, 143,411 input tokens, 8,805 output tokens, 137,344 cache-hit input tokens, 6,067 cache-miss input tokens, 6,279 reasoning tokens; estimated DeepSeek cost is about `$0.01079737`.
  - v7 runtime: environment setup about 48s, agent setup about 0.3s, agent execution about 233s, verifier about 101s.
  - v7 verifier output confirmed `uv` and `uvx` installed successfully, Selenium-based `test_out_html_bypasses_filter` passed, Docker container cleanup was clean, and recursive `sk-` scan found no API key leakage.
- A 3-task Terminal-Bench smoke was started and immediately stopped when Docker Compose was observed to expose the API key through process arguments for `env=` values; future runs should use `--agent-env-file /run/lightcc/deepseek.env` plus a read-only mount of `/home/sjx/.lightcc/deepseek.env`.
- Safe env-file based 3-task representative smoke completed:
  - run id: `tbench-smoke-batch3-representative-v1`
  - tasks: `terminal-bench/build-cython-ext`, `terminal-bench/break-filter-js-from-html`, `terminal-bench/bn-fit-modify`
  - Harbor completed `3/3` trials with `0` runtime errors and mean reward `0.0`.
  - Total wall time: about `37.2` minutes.
  - Agent usage across all three trials: 117 requests, 4,513,850 input tokens, 71,653 output tokens, 4,142,848 cache-hit input tokens, 371,002 cache-miss input tokens, 36,763 reasoning tokens.
  - Estimated DeepSeek cost with the existing `deepseek-v4-pro` pricing table: about `$0.238742`.
  - `build-cython-ext`: reward `0.0`; core extension checks mostly passed, but verifier failed on the repository test-suite check because a fresh clone's `tests/` path was missing (`10 passed, 1 failed`).
  - `break-filter-js-from-html`: reward `0.0`; previous v5 single-task run passed, but this batch trial's verifier failed while downloading `uv` from GitHub (`curl: (18)` then `uvx: command not found`), so treat this as an infrastructure/network flake rather than a clean model failure.
  - `bn-fit-modify`: reward `0.0`; verifier ran normally and reported real solution mismatches (`3 failed, 6 passed`), mainly wrong DAG edge direction/missing edge and sampled distribution mismatch.
  - Batch artifacts: `.light-cc/evals/tbench-smoke-batch3-representative-v1/terminal-bench/`.
  - Final Docker container check was clean, and a recursive `sk-` pattern scan over the batch artifacts found no API key leakage.

Notes:

- Newer Harbor docs distinguish registry single-task `-t terminal-bench/<task>` from dataset filtering; this adapter currently uses dataset mode plus `-i <task>`.
- Container-side `lightcc` defaults to `--os-sandbox off` because Harbor already isolates tasks in containers.
- Remaining external validation: stabilize verifier dependency downloads for Terminal-Bench tasks that fetch from GitHub, optionally rerun `break-filter-js-from-html` to separate model variance from network flakes, then wire a unified E5 report across E2/E3/E4.
