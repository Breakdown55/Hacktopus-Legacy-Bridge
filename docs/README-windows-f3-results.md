# Windows F3 handoff · stripped intcalc

## Experiment

Ran the protocol in the [Windows F3 handoff](README-windows-ghidra-f3-handoff.md) from commit `dcd9329`. Both variants used the same 16 cases, signed-in Codex CLI default model, original runtime captures, scope statements, prompt, and acceptance assertions. The evidence variant added citations from the stripped executable to the same scope. The test allowed one repair for a build failure, as before.

- The test treats a non-overflow difference as a reported scope gap. An overflow mismatch fails unless the module explicitly lists the untranslated overflow behavior.
- The stripped fixture was built with the Makefile's pinned GCC image and `-O1`. SHA-256 `151177b2046c162f151912a9d83103fe84eaa51cbfca757af8ea22e7b0bf3d74`, 14,392 bytes.
- Windows x64 build 26200, Node 24.16.0, npm 11.13.0, Codex CLI 0.169.0-alpha.11.1. Docker Desktop 4.99.0.245822 with engine 29.9.3 used its WSL2 backend, Linux amd64, 20 CPUs and 7.60 GiB available to Docker. The containers used **runc**. gVisor coverage remains open for this run. The host ran **unsandboxed `tsc`**. Tests used PGlite and a filesystem blob store.
- The test sent the synthetic scope and cited fixture evidence to Codex through its CLI. This experiment was local. The run against the friend's physical server remains open.

## Selecting the function

The test queued the real native index worker on the uploaded stripped ELF. It took Ghidra's indexed `entry` finding and requested deep pseudocode, then resolved the first argument to `__libc_start_main` back to a function in the same index. In this build that callback was `FUN_004011c6` at `0x4011c6`. The arithmetic was inlined into it. Ghidra showed the integer addition, conditional sign handling with `0x100000000`, and `printf` of a value divided by `3.0`. The test derives the address from the index and startup pseudocode each run.

The callback calls `FUN_00401156` for both arguments. Its pseudocode shows `strtoll` with base 10, an end-pointer and range validation. That supplies evidence for both leading whitespace and trailing junk. The scope cites the workflow and parser findings as applicable, including their pseudocode. The test checks the stored evidence count and reads the generation transcript to verify that the selected arithmetic pseudocode actually reached Codex. Both raw evidence and normalized findings carry the stripped ELF's SHA-256.

## Setup and measurement

- `npm install` and the initial typecheck passed. The Windows fixture build needed `MSYS2_ARG_CONV_EXCL='*'`, `MSYS_NO_PATHCONV=1`, and an explicit `CURDIR` with a Windows drive and forward slashes. This prevented MSYS from turning the container's `/f` into a host path. Docker's bin directory also had to be on PATH to resolve its credential helper. The test passes the resolved Docker executable to each runner.
- The pinned REA 6.9.0 and Ghidra 12.1 image `lb-analysis:f1` built in **3.847 s with cached layers**, with 19.19 GiB free disk before setup. Its local image ID was `sha256:4ab01cd2cfa8b23122df27ff66c61ee5df9561107bdae499aa8582d57547f971`.
- The live S2 check passed **5/5**. The stripped-ELF index and deep case took **126.121 s**. The outer test command took **133.508 s**.
- The F3 index time includes queueing, worker execution, and persistence. Per-operation time includes container startup and the relevant REA call. Peak memory is the Linux container's cgroup v2 `memory.peak`, read after REA exits. It includes the command container's cgroup footprint. The host VM and Docker image-build memory were outside this measurement.

To rerun, follow the environment setup in the original handoff. Use `LB_F3_VARIANT=baseline` or `LB_F3_VARIANT=evidence` with `LB_TEST_LIVE_CODEX=1` and a distinct `LB_F3_REPORT` for each run. The evidence variant also needs `LB_ANALYSIS_IMAGE` set to the pinned image ID.

## What pseudocode changed

All three no-evidence runs built and matched **12/16**. Each used exact addition and listed `overflow` as untranslated. Positive, negative, and large positive overflow differed. Each missed `leading space` as well. On that case the baseline rejected the input with exit code 2, while the original printed `2.33\n` and exited 0.

The two completed evidence runs built and matched **16/16**. Each supplied four evidence items, including the selected arithmetic pseudocode. Both reproduced the 32-bit wrap for all three tested overflow inputs, matched the leading-space behavior, and returned an empty untranslated list. These results cover the tested fixture and cases.

Evidence run 3 **failed** in evidence collection. The index completed, but Windows entered Modern Standby when the lid closed at 8:04:06 PM local time and resumed around 9:32:19 PM. Windows Kernel-Power events 506 and 507 bracket the gap. The entry decompile was aborted, and the test hit its 20-minute timeout on resume. No scope approval, Codex generation, module build, or case comparison occurred. The failed run is kept as the third attempt. Its aborted decompile elapsed time includes standby and has no peak-memory reading.

## Per-run outcomes

| JSON report | Acceptance | Build result and time | Matches | Cases that differ | Evidence items | Total run (s) |
|---|---|---|---:|---|---:|---:|
| [baseline-1](f3-windows-results/baseline-1.json) | Pass | succeeded (0.436 s) | 12/16 | large positive overflow, leading space, negative overflow, positive overflow | 0 | 64.214 |
| [baseline-2](f3-windows-results/baseline-2.json) | Pass | succeeded (0.425 s) | 12/16 | large positive overflow, leading space, negative overflow, positive overflow | 0 | 62.151 |
| [baseline-3](f3-windows-results/baseline-3.json) | Pass | succeeded (0.699 s) | 12/16 | large positive overflow, leading space, negative overflow, positive overflow | 0 | 71.933 |
| [evidence-1](f3-windows-results/evidence-1.json) | Pass | succeeded (0.568 s) | 16/16 | None | 4 | 278.076 |
| [evidence-2](f3-windows-results/evidence-2.json) | Pass | succeeded (0.695 s) | 16/16 | None | 4 | 270.025 |
| [evidence-3](f3-windows-results/evidence-3.json) | Fail (collecting_evidence) | Unavailable | — | Unavailable | — | 5428.215 |

## Windows Docker analysis timings

| Run | Index worker wall (s) | Entry pseudocode (s) | Arithmetic pseudocode (s) | Parser pseudocode (s) | All deep worker jobs (s) | Peak across measured operations |
|---|---:|---:|---:|---:|---:|---|
| Evidence 1 | 74.009 | 18.661 | 21.638 | 23.616 | 133.054 | 818.0 MiB (857718784 bytes) · decompile |
| Evidence 2 | 66.689 | 22.683 | 23.465 | 23.332 | 138.213 | 845.4 MiB (886517760 bytes) · decompile |
| Evidence 3 | 67.603 | Aborted (5303.179 elapsed) | — | — | — | 868.1 MiB (910315520 bytes) · xrefs |

## Full untranslated lists

### Baseline 1

```json
[
  {
    "id": "overflow",
    "file": "src/index.ts",
    "line": 36,
    "reason": "Native intermediate addition width and overflow behavior are unspecified. The implementation uses exact mathematical addition for all accepted inputs. Legacy equivalence for sums outside the signed 32-bit range remains unverified.",
    "evidence": [
      "Both arguments must be signed 32-bit integers.",
      "The approved behavior specifies addition and division by 3, but supplies no implementation or overflow observations."
    ],
    "behaviorId": "sum-scale"
  }
]
```

### Baseline 2

```json
[
  {
    "id": "overflow",
    "file": "src/index.ts",
    "line": 40,
    "reason": "The evidence does not specify the native intermediate integer width or overflow behavior when adding signed 32-bit inputs. The implementation uses exact mathematical addition, including sums outside the signed 32-bit range.",
    "evidence": [
      "Inputs are restricted to signed 32-bit integers.",
      "The approved behavior specifies addition followed by division by three, but supplies no native overflow observations or implementation evidence."
    ],
    "behaviorId": "sum-scale"
  }
]
```

### Baseline 3

```json
[
  {
    "id": "overflow",
    "file": "src/index.ts",
    "line": 38,
    "reason": "The evidence does not establish the native addition width or overflow behavior when two valid signed 32-bit arguments have a sum outside that range. The implementation uses exact mathematical addition; native overflow equivalence remains unverified.",
    "evidence": [
      "Arguments must individually be signed 32-bit integers.",
      "No native implementation or boundary observations were supplied."
    ],
    "behaviorId": "sum-scale"
  }
]
```

### Evidence 1

```json
[]
```

### Evidence 2

```json
[]
```

### Evidence 3

Unavailable. The run ended before the generated revision was recorded.


## Final verification

- `npm run typecheck` passed.
- `npm test -- --reporter=verbose --maxWorkers 4` passed with **131 passed and 6 skipped** across 21 files (19 passed files and 2 skipped files). The Docker import-to-export test ran. Skips were the POSIX signal test on Windows, the S3 integration without an endpoint, the opt-in live S2 case, the opt-in live Codex generation smoke, and the two opt-in live F3 tests. The live S2 and six F3 attempts were measured separately above.

