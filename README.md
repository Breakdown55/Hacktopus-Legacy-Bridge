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

## Private demo on two laptops

The hosting laptop runs Next.js, PostgreSQL, and S3-compatible storage. The processing laptop polls the site over HTTPS, downloads one leased job, runs REA with Ghidra, and uses its signed-in Codex CLI to summarize the static evidence. It sends back findings and candidate features for the Select page. PostgreSQL and object storage stay on the hosting side. The processing laptop needs outbound access to the site and Codex.

1. On the **hosting laptop**, start PostgreSQL and S3 with `docker compose -f infra/docker-compose.yml up -d postgres s3`, configure `.env.local` from `.env.example` and set `DATABASE_URL` in the migration shell before running `npm run migrate`. Set `LB_CODEX_ORG_ID` to a dedicated organization UUID. In PostgreSQL, insert that organization with `external_model_allowed = true`: `INSERT INTO organizations (id, name, external_model_allowed) VALUES ('<org-uuid>', 'Codex demo', true);`
2. Generate two different secrets (at least 32 characters each) for `LB_CODEX_DEMO_KEY` and `LB_CODEX_WORKER_KEY` on the host. Keep the site behind a login or private network, with HTTPS for remote connections. The browser uses the demo key and the processing laptop uses the worker key. Start the site with `npm run build` and `npm start`.
3. On the **processing laptop**, install the repo dependencies, sign into the CLI with `codex login`, and check `codex login status`. Set the worker environment in PowerShell using your installed paths:

```powershell
$env:LB_SITE_URL = 'https://demo.yourdomain.me'
$env:LB_CODEX_WORKER_KEY = '<worker key from the hosting laptop>'
$env:LB_REA_ENTRY = 'C:/path/to/rea-agents/scripts/rea.mjs'
$env:LB_REA_NODE = 'C:/path/to/node.exe'
$env:GHIDRA_INSTALL_DIR = 'C:/path/to/ghidra'
$env:JAVA_HOME = 'C:/path/to/jdk'
# Set LB_CODEX_BIN to the path to codex.exe if codex is not on PATH.
npm run worker:codex
```

4. Open **Import**, choose a trusted PE or ELF executable (up to 16 MiB), enter the demo key, and click **Analyze executable**. If the worker is offline, the job stays queued. The browser can reopen the same job from Import or Select. Use **Add candidates to Select** to review and choose what to carry forward.

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
