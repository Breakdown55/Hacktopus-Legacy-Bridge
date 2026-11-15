# Windows handoff: Ghidra evidence and F3 on stripped `intcalc`

Written for: an engineer or agent on an x86-64 Windows PC with Docker Desktop (WSL2 backend) and a signed-in Codex CLI. Nothing here has been run on Windows by the author of this note.

## Goal

Re-run the F3 acceptance case for the **stripped `intcalc`** fixture with **real REA/Ghidra pseudocode as evidence**, and compare the result with the no-evidence run described below. Then report back.

Acceptance (plan §10.1 F3, §10.2 S4): the generated module builds, and it either matches the original on every case or **explicitly lists the behavior it could not translate** (32-bit overflow). Also measure Ghidra time and memory natively (F1 timings from a Mac under emulation are not meaningful).

## Why Windows

The analysis image is `linux/amd64`. On Apple Silicon it runs under emulation (slow), and the authoring Mac had about 6.7 GiB of free disk. Docker Desktop on x86 Windows runs it natively.

## Baseline already recorded (no decompiler evidence)

Run on macOS (Docker runc, PGlite, local blob store, unsandboxed `tsc`), Codex CLI default model:

- Test: `tests/e2e/intcalc-generation.test.ts` with `LB_TEST_LIVE_CODEX=1`. The scope was written from black-box observation, did not mention overflow, and cited **no findings** (`evidence_items: 0`).
- First run, original prompt: module built, silently used exact JS addition, `untranslated` was empty, 3 overflow cases differed. That fails acceptance.
- After adding a "flag native integer/rounding semantics you did not reproduce" rule to the prompt in `workers/generation/codex.ts`: module lists `overflow` as untranslated. 12 of 16 cases match. The 3 overflow cases differ (covered by the untranslated entry). `leading space` also differs because `strtoll` accepts leading whitespace and the scope did not say so (reported as a scope gap, non-blocking).
- One run, one scope, prompt tuned against this same test. Treat the result as weak evidence.

## Prerequisites

- Windows 10/11 x86-64, Docker Desktop with the WSL2 engine, **at least 20 GiB free disk** (image about 2-3 GB plus build layers) and 8 GiB memory available to Docker (Settings > Resources).
- Node 22.2 or newer, Git, and the Codex CLI signed in: `codex login status` should print "Logged in".
- Network access during the image build (Ghidra from GitHub, `rea-agents@6.9.0` from npm). The Dockerfile pins every download by checksum or digest.
- Permission to send the synthetic scope and evidence to the external model. The test enables `external_model_allowed` on its own throwaway org.

## Steps (PowerShell, from the repo root)

1. Install and sanity check:

   ```powershell
   npm install
   npm run typecheck
   ```

2. Build the fixtures (needs Docker; builds `fixtures/bin/intcalc` and `intcalc.stripped`):

   ```powershell
   npm run fixtures
   ```

3. Build the analysis image and record its ID:

   ```powershell
   docker build --platform linux/amd64 -t lb-analysis:f1 -f infra/images/analysis/Dockerfile infra/images/analysis
   $env:LB_ANALYSIS_IMAGE = (docker image inspect --format '{{.Id}}' lb-analysis:f1).Trim()
   $env:LB_S2_TEST_IMAGE = $env:LB_ANALYSIS_IMAGE
   ```

   Note the wall-clock time of the build.

4. Confirm Ghidra evidence works with the existing live S2 test:

   ```powershell
   npm test -- tests/api/analysis.test.ts
   ```

   The live stripped-ELF test must run, not skip. Record its duration. Optionally rerun the F1 spike per [f1-analysis-spike.md](f1-analysis-spike.md) for timing and peak memory.

5. Confirm the baseline still reproduces on this machine (no evidence). Use the real Codex binary path:

   ```powershell
   $env:LB_TEST_LIVE_CODEX = '1'
   $env:LB_CODEX_BIN = (Get-Command codex.exe).Source
   $env:LB_F3_REPORT = "$PWD\.cache\f3-baseline.json"
   npm test -- tests/e2e/intcalc-generation.test.ts
   ```

6. **The new work: add the evidence variant.** The current test never runs the analysis worker and cites no findings. Extend `tests/e2e/intcalc-generation.test.ts` (or add a sibling test) so that, after import and before approving the scope:

   - the test env passes `rea: new DockerReaAnalysisRunner({ image: process.env.LB_ANALYSIS_IMAGE })` (see `workers/run.ts` and `workers/analysis/rea/runner.ts`);
   - it calls `queueNativeAnalysis(c, source, ...)` from `server/domain/analysis.ts` with an index request (see `analysisRequest` in `server/api/handlers.ts` for the request shapes) and runs `drain(env, ['native_index'])`;
   - it requests deep pseudocode for the function that does the add and scale (a `native_deep_function` request). The binary is stripped, so choose the function from the index findings, for example the one that references the usage string or calls `printf`. Do **not** read the symbol from the unstripped binary and hardcode it, or the test no longer measures stripped-code behavior. If the right function cannot be selected automatically, say so in the report;
   - the scope behaviors cite those finding ids in `evidence`;
   - `evidence_items` in the stored `generator.params` is greater than 0.

   Keep the same 16 cases and the same acceptance assertions. Write the report to a separate `LB_F3_REPORT` path.

7. Run it:

   ```powershell
   $env:LB_F3_REPORT = "$PWD\.cache\f3-with-evidence.json"
   npm test -- tests/e2e/intcalc-generation.test.ts
   ```

   Repeat at least three times per variant (with and without evidence) and keep each report. A single pass says little about a nondeterministic model.

8. Run the full suite and typecheck before saying anything works:

   ```powershell
   npm run typecheck
   npm test
   ```

## What to report back

- Build time for `lb-analysis:f1`, index time, pseudocode time, and peak Docker memory.
- For each run, with and without evidence: build result, number of cases that match, which cases differ, and the full `untranslated` list.
- Whether pseudocode evidence changed the outcome. Does Codex now reproduce the 32-bit wrap exactly (all 16 match), or still list overflow? Did it stop being wrong about leading whitespace?
- Anything that behaved differently on Windows (path handling, Docker mounts, skipped tests). The POSIX-only test is expected to skip.

## Limits to state in any report

- Docker Desktop is plain runc, not gVisor. Isolation flags are applied, `runtime: 'runsc'` is not.
- The `tsc` build runs on the host without isolation (`localBuild`).
- Tests use PGlite and a filesystem blob store unless you set `TEST_DATABASE_URL` or `S3_TEST_ENDPOINT`.
- Generation sends scope and cited evidence to an external model through the signed-in Codex CLI.
- Do not commit, do not read `.env`, and leave the owner's deletion of `index.html` alone.
- The test on the friend's actual server remains open until that machine is reachable. See [README-codex-handoff.md](README-codex-handoff.md) for that two-laptop run.
