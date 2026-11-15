# F1 · REA and Ghidra feasibility

F1 tests whether Legacy Bridge can use the REA CLI to collect structured static evidence from Linux x86-64 executables. The plan calls for three fixtures, stripped and unstripped, with two runs at the same input path to compare evidence IDs.

## Inputs and method

- Analysis image: `lb-analysis:f1`. The [Dockerfile](../infra/images/analysis/Dockerfile) selects REA 6.9.0, Ghidra 12.1, Node 24.22.3, and Temurin JDK 21. The Ghidra archive is checked against the [official release checksum](https://github.com/NationalSecurityAgency/ghidra/releases/tag/Ghidra_12.1_build).
- Fixtures: `wordfreq`, `intcalc`, and `rand`. The [build script](../infra/images/analysis/f1-fixtures.sh) uses the repo's pinned GCC image to build non-PIE ELFs, then strips copies of the same binaries. It records a function address from `nm` before stripping. That address is a known selector for the xref and pseudocode tests. This experiment does not measure how reliably Legacy Bridge can choose that address without symbols.
- Each pass runs four separate CLI processes. The [runner](../infra/images/analysis/f1-runner.mjs) saves complete stdout and stderr, checks exit status, nonempty findings, source SHA-256, and reported Ghidra provider, then compares the two evidence IDs. The five-minute limit applies to all four calls together in each pass.
- The fixtures are static analysis inputs. The analysis runner does not invoke the uploaded executables.

## Commands and result shapes

| Evidence | CLI arguments before `--provider ghidra --json` | Shape observed on the Docker baseline |
|---|---|---|
| Procedures | `search TARGET '.+' --kind procedures --mode regex` | `normalized_result` array of address, value, and symbol/procedure metadata |
| Strings | `search TARGET '.+' --kind strings --mode regex` | `normalized_result` array of address, value, and string metadata |
| Cross-references | `xrefs TARGET ram:0xADDRESS` | `normalized_result` array of untyped source addresses |
| Pseudocode | `decompile TARGET ram:0xADDRESS` | `normalized_result` pseudocode string |

The default `search` output is bounded. Treat the returned rows as observed results until S2 measures coverage and chooses a way to retrieve or report missing inventory. Ghidra's string search covers data it identified as strings. The CLI xref output does not identify reference types. See the [REA project](https://github.com/morluto/rea) for CLI documentation.

## Reproduce

From the repository root in a Linux shell with Docker, using a repository path the daemon can mount:

```sh
docker build --platform linux/amd64 -t lb-analysis:f1 -f infra/images/analysis/Dockerfile infra/images/analysis

docker run --rm --platform linux/amd64 \
  --mount "type=bind,source=$PWD/fixtures,target=/f" \
  --mount "type=bind,source=$PWD/infra/images/analysis,target=/spec,readonly" \
  gcc:13@sha256:8c0fe724784c6d617cb582f79ddaf5dd2233aaba2fb7a14e0b9d03348fea8088 \
  sh /spec/f1-fixtures.sh

mkdir -p .cache/f1/results
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --memory 8g --memory-swap 8g \
  --tmpfs /tmp:rw,size=1g,mode=1777 \
  --mount "type=bind,source=$PWD/fixtures/bin/f1,target=/fixtures,readonly" \
  --mount "type=bind,source=$PWD/infra/images/analysis,target=/spec,readonly" \
  --mount "type=bind,source=$PWD/.cache/f1/results,target=/results" \
  lb-analysis:f1 node /spec/f1-runner.mjs
```

If Docker has a configured `runsc` runtime, add `--runtime=runsc` to the analysis command. The results directory must be writable by container UID 1000.

For standalone gVisor, export a stopped scratch container's filesystem with `docker export`, then run [`infra/runsc/f1-oci.sh`](../infra/runsc/f1-oci.sh) as root on the Linux host. Pass the path to a verified [gVisor release](https://gvisor.dev/docs/user_guide/install/), the exported tar, fixture directory, analysis script directory, and writable output directory. The script runs that same filesystem with the systrap platform, external networking disabled, and an 8 GiB systemd scope. It reports the host cgroup memory cap and peak. Docker Desktop does not need its runtime configuration changed for this standalone experiment.

```sh
container=$(docker create lb-analysis:f1)
docker export -o .cache/f1/analysis-rootfs.tar "$container"
docker rm "$container"
mkdir -p .cache/f1/gvisor
sudo sh infra/runsc/f1-oci.sh /path/to/runsc .cache/f1/analysis-rootfs.tar \
  fixtures/bin/f1 infra/images/analysis .cache/f1/gvisor
```

## Results

All four CLI commands **worked** on all six ELF variants under standalone gVisor `release-20261109.0` (systrap) in Ubuntu WSL 2. No command needed the MCP-over-stdio fallback on these inputs. The Docker image manifest was `sha256:db34b31c52cf7d2e1584c2d9d52237d22b8b0a12c162374c5b42de4b55826d58`.

| Fixture | First pass | Repeat | Procedure rows | String rows | Xrefs | Pseudocode chars |
|---|---:|---:|---:|---:|---:|---:|
| `wordfreq` | 92.9 s | 92.5 s | 53 | 101 | 4 | 578 |
| `wordfreq.stripped` | 88.9 s | 88.1 s | 53 | 53 | 4 | 704 |
| `intcalc` | 88.9 s | 88.9 s | 28 | 77 | 3 | 250 |
| `intcalc.stripped` | 81.1 s | 79.4 s | 28 | 41 | 3 | 253 |
| `rand` | 83.2 s | 82.0 s | 24 | 75 | 3 | 113 |
| `rand.stripped` | 83.2 s | 77.3 s | 24 | 41 | 3 | 114 |

Each pass was under five minutes. The observed host cgroup peak for the **whole batch** was 2,577,637,376 bytes (2.40 GiB), with up to three variants in flight, an enforced 8 GiB cap and no swap. The first wrapper failed to print its closing memory lines because systemd expanded a shell variable early. The independent cgroup reader captured the measurements, and the checked-in wrapper disables that expansion.

All 24 evidence ID pairs matched with the same artifact bytes, target path, provider version, and command arguments. The raw evidence and per-fixture summaries are in `.cache/f1/gvisor/`. These results do not establish stable IDs after moving a binary or changing versions.

The stripped procedure rows include all text-symbol addresses in the small `nm` oracle: `wordfreq` 12/12, `intcalc` 11/11, and `rand` 10/10. Each count includes the compiler-generated `frame_dummy` thunk. Count imports and thunks separately from ordinary procedures in S2. The stripped `wordfreq` pseudocode labels the selected routine `FUN_00401286`, while the unstripped result labels it `add`. The address check measures where a function is recoverable, independent of its original name.

The runc baseline on unstripped `wordfreq` returned 53 procedure rows, 101 string rows, 4 xrefs, and 578 characters of pseudocode for the selected function. Passes took 61.4 s and 43.3 s, including fresh REA processes. All four evidence IDs matched. Container cgroup peak was 906,698,752 bytes (0.84 GiB). Raw evidence is in `.cache/f1/runc-smoke/wordfreq/`.
