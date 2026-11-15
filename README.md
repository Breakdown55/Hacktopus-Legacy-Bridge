# Legacy Bridge

Legacy Bridge turns functionality from legacy executables into reusable code for modern applications, with rerunnable tests to check that it preserves the original behavior.

## Workflow

**Import → Select → Modernize → Verify → Export**

1. **Import** the legacy executable and optional context.
2. **Select** the functionality to modularize.
3. **Modernize** it into a reusable code module.
4. **Verify** it against original behavior where available.
5. **Export** the module and rerunnable tests.

## UI prototype

Built with Next.js (App Router) and React. Run `npm ci`, then `npm run dev` and open http://localhost:3000. The project picker is at `/`, and each workflow stage has its own route under `/projects/<id>/`. Projects, notes, and photo or video attachments are saved in that browser. Modernize, Verify, and Export still preview the workflow and export a project plan.

## S1 browser workflow

For the Windows test instance and the Mac profile switch, see the [Windows TEST handoff](docs/README-windows-test-handoff.md).

Use the S1 feature flag to run the actual backend from the five pages. This mode is for loopback development with a dedicated dev organization and user. It uses the built-in Linux x86-64 ELF inspector and a supplied TypeScript replacement.

1. Start Docker and run `docker compose -f infra/docker-compose.yml up -d postgres s3`.
2. Load the database, S3, and development values from `.env.example` into the shells that run Next.js, the migrations, and the worker. Set `NEXT_PUBLIC_LB_S1_UI=1` and assign two new UUIDs to `LB_S1_ORG_ID` and `LB_S1_USER_ID`. Run `npm run migrate` and `npm run s1:seed`. The seed enables sandbox execution for the new demo organization; the UI still requires consent for each executable.
3. Make sure Docker's CLI and credential helper are on PATH. Pull the pinned original and replacement images before the first capture so Docker's download output stays out of the program streams:

```text
docker pull debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc
docker pull node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
```

4. Start `npm run worker` with `LB_SANDBOX=direct`. On Windows, set `LB_WORK_ROOT` to an absolute writable directory. The existing worker runs TypeScript compilation locally and runs originals and replacements in Docker.
5. Run `npm run dev -- --hostname 127.0.0.1 --port 3100` and open http://127.0.0.1:3100. Keep this dev mode on loopback.

For the sample, build `fixtures/bin/wordfreq` with `npm run fixtures`. Create a project, upload `wordfreq`, and run **Probe original** after granting consent. Approve the scope on Select. Upload `fixtures/replacements/wordfreq-v1/src/index.ts` on Modernize. On Verify, choose **Load wordfreq cases**, **Save cases**, **Capture original outputs**, and **Run verification** in that order. On Export, choose **Build export** and **Download ZIP**. Unpack it and run `node harness/verify-integrity.mjs` and `node harness/run-cases.mjs` from its package directory.

## S2 executable evidence

With the local browser workflow enabled, build the pinned REA 6.9.0 and Ghidra 12.1 analysis image and select its exact ID in the worker shell:

```powershell
docker build --platform linux/amd64 -t lb-analysis:f1 -f infra/images/analysis/Dockerfile infra/images/analysis
$env:LB_ANALYSIS_IMAGE = (docker image inspect --format '{{.Id}}' lb-analysis:f1).Trim()
npm run migrate
npm run worker
```

On **Select**, choose **Build evidence index** for an imported Linux x86-64 ELF. Browse functions, strings, imports, and the incoming references returned for an indexed entry. Open a finding to inspect its addresses, artifact hash, and tool versions, then choose **Download raw evidence** to inspect the original REA response. In a function finding, **Request pseudocode** runs deeper analysis for that address. Use **Cite in scope** to add findings to draft scope behaviors. The worker records coverage limits with each run. Findings are static evidence from the executable, and behavior verification happens on **Verify**.

The analysis worker mounts the uploaded file read-only in a non-root container with no network and bounded resources. Set `LB_ANALYSIS_RUNTIME=runsc` when using a Docker engine with gVisor registered. See the [F1 report](docs/f1-analysis-spike.md) for the pinned image and fixture build commands.

After building the F1 fixtures, set `LB_S2_TEST_IMAGE` to the same image ID and run `npm test -- tests/api/analysis.test.ts` to include the live stripped-ELF test. The regular suite also checks recorded REA responses, raw evidence, and scope citations.

## S3: scope editing and approvals

On **Select**, the scope is a structured form: the workflow and its arguments, the behaviors to modernize (each with how you know it: observed, inferred, customer requirement or intentional change), dependencies on time, randomness, environment, files and network with who is responsible after the move, assumptions, decisions, and open questions. **Cite in scope** on any finding attaches it as evidence. Inputs, outputs, required state and intentional changes are edited in the JSON view.

1. **Save draft.** Saves use optimistic locking (`If-Match`). If someone else saved first the save fails with 412 and you can discard your edits to load their draft.
2. **Create revision for review.** Seals the saved draft as an immutable, numbered revision. Citations are checked against the current source revision.
3. **Approve or reject.** Review a revision, then approve it or reject it with a reason. Approval needs at least one behavior, a revision written for the current source revision, and the exact document digest you reviewed. Open questions do not block approval; they are recorded with it. A revision is decided once. Two simultaneous approvals give one 200 and one 409.
4. **Change the scope later** with **Edit a copy as the draft** on any revision. The new revision records its parent. Approving it makes earlier verification runs stale (`scope_reapproved`), and Modernize reports `module_scope_outdated` until a module is built against the new scope.

Re-importing the executable leaves the old approval behind: Select reports `scope_source_changed` until a scope is approved for the new source revision.

The approved revision is the input to code generation (S4). `GET /api/v1/scope-revisions/{id}` returns its document, its decision, and every cited finding with artifact path and digest. `GET /api/v1/projects/{id}/scope-revisions` lists revisions with status and the current approved head.

The default prototype also rejects files that are not ELF, PE or Mach-O on Import, clears Select and later progress when the executable changes, and blocks Export while no feature is selected.

## S4: code generation and source edits

When creating a project, choose **TypeScript**, **Python**, **Go**, **Java**, or **C#**. On **Modernize**, **Generate** uses the chosen language's public entry point, the approved scope, and the findings it cites. **Repair current module** sends the current files and their build diagnostics with optional instructions. Each result is a new numbered revision that builds automatically. You can edit files or upload your own replacement source in the selected language.

| Target | Required source file | Packaged output |
| --- | --- | --- |
| TypeScript / Node.js 22 | `src/index.ts` | JavaScript and declarations |
| Python 3.12 | `src/replacement.py` | Syntax-checked Python with a CLI launcher |
| Go 1.24 | `src/replacement.go` | Go module source and a Linux amd64 CLI |
| Java 21 | `src/Replacement.java` | JAR with a public replacement class |
| C# / .NET 8 | `src/Replacement.cs` | .NET assembly and project files |

The host needs the pinned Docker image for each target it builds. Pull the digests from [toolchains.ts](workers/build/toolchains.ts) with `docker pull --platform linux/amd64 <image>`. Python, Go, Java, and C# build in offline Docker containers. Verification uses the matching runtime. Exports include source, built files, and replay cases. For these four targets, replay with `node harness/run-cases.mjs --docker`. The existing TypeScript export also supports local Node replay.

For two laptops, use the setup below. For single-machine development, set `LB_GENERATION_PROVIDER=codex` in the `npm run worker` shell and run `codex login` as the worker's OS user. Optionally set `LB_CODEX_BIN` to the CLI executable and `LB_GENERATION_MODEL` to a model available to that account. Without a model override, generation uses the CLI's built-in default. Codex uses its CLI login.

Enable generation per organization with `UPDATE organizations SET external_model_allowed = true WHERE id = '<org>';`. The request returns 409 `external_model_not_allowed` until the setting is enabled. Scope, cited evidence, and any repair files and diagnostics are sent to Codex. The worker requires the provider setting to claim generation jobs.

- **Output checks:** files must be under `src/` or `test/`, use the chosen language's extension, stay within the size limits, and include the required entry file. Builds use standard libraries and trusted configuration. The worker supplies the build files and CLI launcher.
- **Untranslated behavior:** the model lists what it could not translate and marks it with `LB-UNTRANSLATED:<id>`; it marks translated behaviors with `LB-BEHAVIOR:<id>`. The build compares markers, the list and the scope, and reports mismatches and unaddressed behaviors as warnings. Warnings never fail a build.
- **Audit:** each revision records provider, configured model (or `cli-default`), template version, input and output digests, reported token usage, and a blob containing the request and structured response.
- **Limits:** the worker configures the provider and model. Generate jobs get two attempts for transient failures, and cancellation interrupts the CLI. Direct callees of cited functions are outside the current evidence selection. A `generation_output_invalid` failure shows the validator's reason. `tsc` runs on the host in local development.
- **Generate API:** `POST /api/v1/projects/{id}/module-revisions` with `origin: "generated"` returns 202 and a job id; the worker creates the revision.

For a live smoke test using only synthetic data, start Docker with the pinned replacement image from the S1 setup, set `LB_TEST_LIVE_CODEX=1`, and run `npm test -- tests/api/generation.test.ts`. The test starts a separate processing worker and routes a request through the host endpoint over loopback HTTP.

## Private demo on two laptops

For the implementation map, test results, and remaining deployment checks, see the [Codex handoff README](docs/README-codex-handoff.md).

The hosting laptop runs Next.js, PostgreSQL, S3-compatible storage and the main worker. The processing laptop makes outbound HTTPS requests to the host, claims a leased job and runs its signed-in Codex CLI. For generation it receives the approved scope, selected target, cited evidence, and optional repair files, then returns structured source files. The host validates, stores and builds the revision. PostgreSQL and object storage stay on the hosting side.

1. On the **hosting laptop**, follow the database, storage and browser setup above. Set `LB_CODEX_ORG_ID` to your seeded organization's UUID for both the Next.js process and the main worker. Enable `external_model_allowed` on that organization. Set `LB_GENERATION_PROVIDER=codex-remote` in the main worker shell before `npm run worker`. The host needs no Codex login.
2. Set a random `LB_CODEX_WORKER_KEY` of at least 32 characters on the host and the processing laptop. For the optional static analysis demo, set a different `LB_CODEX_DEMO_KEY` on the host and give that key to the browser user. Build and start the production site with `npm run build` and `npm start`, and proxy `/api/codex/generation` over HTTPS with a request body limit of at least 5 MiB. For generation from the full workflow UI, run the development site on the host's loopback and use it there or open `http://127.0.0.1:3110` after connecting with `ssh -L 3110:127.0.0.1:3100 user@host`. The full project workflow uses the loopback development UI until production user authentication is available.
3. On the **processing laptop**, install the repo dependencies, sign into the CLI with `codex login`, and check `codex login status`. Set the worker environment in PowerShell using your installed paths:

```powershell
$env:LB_SITE_URL = 'https://demo.yourdomain.me'
$env:LB_CODEX_WORKER_KEY = '<worker key from the hosting laptop>'
# REA and Ghidra are only needed to claim optional static analysis demo jobs.
$env:LB_REA_ENTRY = 'C:/path/to/rea-agents/scripts/rea.mjs'
$env:LB_REA_NODE = 'C:/path/to/node.exe'
$env:GHIDRA_INSTALL_DIR = 'C:/path/to/ghidra'
$env:JAVA_HOME = 'C:/path/to/jdk'
# Set LB_CODEX_BIN to the path to codex.exe if codex is not on PATH.
npm run worker:codex
```

4. Open the full workflow on loopback, approve a scope on **Select**, then click the selected language's **Generate** button on **Modernize**. The processing laptop claims the request and sends the result to the hosting laptop. In the optional static analysis demo, use **Analyze executable** on **Import** with a trusted PE or ELF (up to 16 MiB) and the demo key.

Use this path for private, trusted demos. The worker performs static inspection and sends bounded REA evidence and project context to Codex using the worker account's allowance. The worker does not run the uploaded file or claim that any behavior passed runtime verification. The host retains the submitted artifact and job record; deleting a browser project removes its local data only.

## Backend

The separate revision, verification, and export API under `app/api/v1` follows the [Backend Implementation Plan](docs/backend-plan.md).

```
npm test                       # unit + API + e2e (e2e needs Docker and `make -C fixtures`; it skips with a reason otherwise)
npm run typecheck && npm run build
TEST_DATABASE_URL=postgres://lb:lb@localhost:5432/postgres npm test   # same suite on real PostgreSQL
S3_TEST_ENDPOINT=http://localhost:9090 npx vitest run tests/integration   # S3 store against an S3-compatible server
docker compose -f infra/docker-compose.yml up -d postgres s3 && DATABASE_URL=… npm run migrate
```

Known gaps (see the plan): isolation is plain Docker (runc), and `tsc` builds run unsandboxed on the host (`LB_SANDBOX=direct`, refused in production). Production login and module generation are still pending. Original binaries and replacement modules run in hardened containers (no network, read-only rootfs, non-root, caps dropped).
