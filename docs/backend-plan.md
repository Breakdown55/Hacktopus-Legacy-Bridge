# Legacy Bridge — Backend Implementation Plan (with implementation status)

> **Implementation status, 2026-11-14.** The plan below is the original design, copied from the planning session; only its title and status line were changed.
> This block records what has been built against it. Where the two disagree, the code and this block win.
>
> **Slice S1 (walking skeleton): backend and local browser workflow implemented.** See the [S1 setup](../README.md#s1-browser-workflow). The separate prototype still works when the flag is off.
>
> | Plan item | Status |
> |---|---|
> | §3 schema, immutability triggers, composite org FKs | Built (`server/db/migrations/0001_init.sql`), tested on PG16. Plain SQL migrations behind a small `Db` interface; **Drizzle is not used** (deviation from §3 / §10.0). |
> | §4 job queue (SKIP LOCKED, leases, reaper, retry, cancel) | Built and tested, including a true concurrent claim race on PG16. |
> | §4.4 invariants, staleness (`applies_to_current`), binding digests | Built and tested (`server/domain/`). |
> | §5 API | 30 routes under `app/api/v1`, `next build` passes. Tested by calling handlers with real `Request` objects, not over a running HTTP server. Auth is a **dev-only header scheme** (`LB_DEV_AUTH=1`); OIDC is S7. |
> | §6.1 analysis | Built the REA 6.9.0 / Ghidra 12.1 analysis worker alongside the built-in inspector. The x86-64 ELF index and focused functions record artifact hashes, pinned image IDs, raw evidence, and coverage limits. PE reports an unsupported result. |
> | §6.3 generation | Built (S4): Codex CLI behind `CodeGenerator`, bounded evidence selection, output validator, and a cancellable `generate` job. Set `LB_GENERATION_PROVIDER=codex-remote` for a separate processing laptop or `codex` for local execution. F3 mostly passed for stripped `intcalc` (live Codex, Windows x64 and macOS, Docker runc, unsandboxed `tsc`): without decompiler evidence all 3 runs built and matched 12 of 16, listing `overflow` as untranslated (after the prompt change in `workers/generation/codex.ts`; the first Mac run had silently dropped wraparound). With Ghidra pseudocode cited from the stripped binary, both completed runs matched 16 of 16 with an empty untranslated list; a third run failed when the laptop went into standby. Two evidence runs on one fixture; `wordfreq` (target 80% of cases) and nondeterministic programs untested. Results: [README-windows-f3-results.md](README-windows-f3-results.md). See `tests/e2e/intcalc-generation.test.ts` (`LB_TEST_LIVE_CODEX=1`). Direct callees of selected functions are outside current evidence selection. |
> | §7 harness, compare engine, replay | Built (`workers/execution`, `packages/compare`); the outcome decision (`judge`) is shared by the verify worker and the exported replay. |
> | §8.1 isolation | Original binaries and replacement modules run in hardened containers (no network, read-only rootfs, non-root, caps dropped) on **Docker runc, not gVisor**. **`tsc` builds still run unsandboxed on the host** (`LB_SANDBOX=direct`, refused in production). `RunscLauncher` was deleted: `runtime: 'runsc'` is an option on the Docker runners. |
> | §9 export | Built: deterministic zip, `SHA256SUMS`, integrity verifier, offline replay verified on the host and in `node:22 --network none`. `--docker` / `--original` flags of `run-cases.mjs` are **not implemented**. |
> | §2 object storage | `S3BlobStore` verified against Adobe S3Mock only. MinIO's public images were not pullable (2026-11-14), so `infra/docker-compose.yml` uses S3Mock for dev. |
> | §10.2 S1 "minimal UI wiring behind a feature flag" | Built and exercised with the real `wordfreq` fixture in a browser against PostgreSQL and S3Mock. The UI captured and matched 10 original reference cases and downloaded the ZIP. Enable with `NEXT_PUBLIC_LB_S1_UI=1`. |
> | §10.1 spikes | F1 passed on six ELF variants with standalone gVisor. See the [F1 report](f1-analysis-spike.md). F2 partial (determinism and `network=none` confirmed; faketime, `setarch -R`, gVisor start latency not). F4 partial (checksum enforcement on S3Mock only). F3 mostly passed on `intcalc` (see §6.3), `wordfreq` not run. F5 untouched. |
> | Written but never run | `infra/images/{web,worker}`, `infra/runsc/README.md`, EC2/RDS/S3 deployment. The worker image sets `NODE_ENV=production`, so it refuses to start until the build step is sandboxed or you opt in. |
> | Slice S2 | Findings, candidate signals, focused pseudocode, and scope citations are implemented on Select and the versioned API. The pinned image recovered 12 of 12 reference function addresses from stripped `wordfreq`. The browser flow verified raw evidence download and scope approval against PostgreSQL and S3Mock. Local S2 analysis ran on Docker runc. See [S2 setup](../README.md#s2-executable-evidence). |
> | Slice S3 | Draft editing with `If-Match`, immutable numbered revisions with lineage (`parent_id`, `scope_drafts.base_revision_id`), approve or reject (rejection needs a comment), `GET /scope-revisions/{id}` (document, decision, hydrated cited findings) and `GET /projects/{id}/scope-revisions`. Approval requires at least one behavior and a revision written for the current source revision. Re-approval marks earlier runs `scope_reapproved`; progress reports `scope_source_changed` and `module_scope_outdated`. Select is a structured editor with a JSON view. Tested on PGlite and PG16; the simultaneous-approval test is `Promise.allSettled` over the unique constraint (multi-connection on PG16, single-connection on PGlite). **Not built:** a generation step that consumes the scope (S4); `scope.v1.ts` is still `packages/contracts/src/scope.ts`; the structured form was not exercised in a browser. |
> | Slice S4 | Generation requires the approved scope and organization consent. Codex produces a new revision with template, digests, usage, and transcript. The worker cancels the CLI when its job is cancelled and rechecks consent and scope before publishing. Repair sends prior files and build diagnostics in a fresh request. The build reports behavior marker mismatches as warnings. A live two-process smoke generated a synthetic word-count module and checked two outputs in Docker. The stripped `intcalc` acceptance case passed with and without decompiler evidence (§6.3); the two-laptop deployment over a real domain remains open. |
> | Slice S5 | Mostly built; acceptance cases pass. Tolerance matches record a `tolerance:decimal-v1` trace entry (compare engine now 1.1.0); `ignore` needs a reason on every channel; normalizers are rejected on non-`normalized` modes; `GET /verification-results/{id}` added. Docker e2e (`tests/e2e/s5-verification.test.ts`): naive `intcalc` gives located differences (`first_difference` byte/line/column); a tolerance policy turns the rounding cases into `match` (`raw_equal=false`, with trace) while the overflow case stays `difference`; a `rand` reference is captured `deterministic=false` and yields `needs_reference` until an explicit ignore rule exists. Cancel midway gives `partial` with kept results, and crash-resume leaves no duplicates (`tests/api/verification.test.ts`, PGlite and PG16). Five fast-check property tests. **Deferred:** stateful step sequences and the diff-view UI. Substitutes: Docker runc, PGlite (e2e not re-run on PG16), unsandboxed `tsc`; the Verify UI was not opened in a browser. |
| Slice S6 | Mostly built; acceptance cases pass locally. The export now lists the module's untranslated behaviors, cases that matched only after normalization or tolerance, cited findings with provenance, and correct original-binary instructions; `module/examples/basic.mjs` added; `applies_to_current_at_export` moved out of the manifest into `getExport` so the same binding gives an identical `SHA256SUMS` even after the run goes stale. `run-cases.mjs` gained `--docker` (hardened container replay) and `--original` (recapture from the packaged original and report; writes nothing back). `tests/e2e/s5-verification.test.ts` exports the `intcalc` tolerance run (with the original) and the `rand` ruled run, then checks integrity, host replay, `--docker` replay and `--original`; `tests/api/export.test.ts` (PGlite and PG16) and `tests/unit/export-harness.test.ts` cover the rest. **Gaps:** the replay CI lane is this vitest e2e only (no workflow file, never run in CI); no `package-lock.json` is produced, so the `npm ci` fallback in `run-cases.mjs` is broken (it is not reached because `dist` ships); zip entries are mode 0644 (users must `chmod +x`; `--original` stages its own copy); the run binding does not store the engine version, so older runs record `unknown`; signing `SHA256SUMS` is still later; Export UI not opened in a browser. Docker runc, not gVisor. |
| Slice S7 | Mostly built; nothing run against a real IdP or AWS. **RLS:** migration `0003_rls.sql` creates `lb_api`/`lb_worker`/`lb_purge`/`lb_migrate`, and enables and forces org policies on every `org_id` table (policies admit worker/purge/migrate by role name, not `BYPASSRLS`, whose availability on RDS is unverified). `Db.withOrg(orgId, fn)` runs each API request on one connection as `lb_api` with `app.org_id` set; `route()` checks membership inside that scope. `tests/api/rls.test.ts` derives the table list from `information_schema`, and passes on PGlite and PG16 (cross-org reads, inserts and updates fail or touch nothing with no repository filter). Owner/superuser connections bypass RLS. Workers connect with `LB_DB_ROLE=lb_worker`; `server/api/codex-jobs.ts` and `codex-generation.ts` still use the unscoped base db. **Login:** Auth.js (`@auth/core`, as the plan named) with one generic OIDC provider and encrypted-JWT session cookies (no `sessions` table); org from `X-Org-Id`, checked against membership; dev headers refused in production. IdP identities link to invited users only on a verified email. First admin: `npm run bootstrap-admin`. Tested with minted cookies, not an IdP handshake. **Members, settings, audit, quotas, health:** `/org/members`, `/org` (execution and external-model settings), `/org/audit-events`, §8.7 quotas (429 `quota_exceeded`) enforced at API entry points, `GET /healthz`. **Purge:** hourly `purge` job per org; soft-deleted projects older than 7 days are removed with their unique blobs (store and table), shared blobs kept; staging and expired export zips cleaned (S3 delete verified on S3Mock only). **Not done:** login UI, concurrent-job and export-size quotas, events `upload.completed`, `policy.created`, `analysis.*`, `project.purged` and request ids, alerts and metrics, bucket lifecycle rule, `lb_reject_mutation` returns `OLD` for `lb_purge` (purge works around it). |
>
> Decisions taken: local development on Docker, production target one AWS EC2 Linux host with gVisor, RDS PostgreSQL and S3 (§12.5 Q1).
> Still open: §12.5 Q2–Q5 (first customer workload, model data policy, target language, retention/redistribution).

_Original status line: planning only, as of 2026-11-14._

## Context

Legacy Bridge has a working UI prototype for **Import → Select → Modernize → Verify → Export**. Nothing behind it is real yet: no executable leaves the browser, and analysis, generation, verification and export are all mocked. This plan defines the backend that makes the workflow real. Its value comes from durable evidence, approved scope, exact revision tracking, reference capture, verification, and a handoff package that can be reproduced. Reverse-engineering and decompilation come from existing tools (REA + Ghidra) instead of being rebuilt.

### What exists vs. what is proposed (repository inspection, commit `4c52d2b`)

| Area | Exists today | Proposed |
|---|---|---|
| Stack | Next.js 16 App Router, React 19, TypeScript 7 (`package.json`), npm | Keep. Add Route Handlers for the API and a separate Node worker process. |
| Import | `components/Workflow.tsx` stage 0 stores **only `file.name`** in `Project.source`. No bytes leave the browser. The label says "Upload code" (source code), not executable. | Real uploads go straight to object storage. Each upload becomes an immutable source revision with hashes. |
| Context | `components/ContextPanel.tsx` takes **image/video only**, kept in IndexedDB (`lib/attachments.ts`). Notes are plain text in localStorage. | Supporting files of any type become source-revision artifacts. Notes and objectives are stored on the revision. |
| Select | `Project.features` / `selected` are free-text strings. The "Detected features" for demo projects are hard-coded (`lib/projects.ts#createTemplates`). | Candidates backed by evidence (functions, strings, entry points), plus a scope/interface document that is versioned and approved. |
| Modernize | A static list ("Analyze structure / Isolate / Prepare TypeScript modules"). | Generated or customer-written TypeScript module revisions, with build results. |
| Verify | A static table. Demo projects show "Sample pass". Others show "Pending" and "Automated verification requires a backend." | Reference capture in a sandbox, versioned comparison policies, per-case outcomes. |
| Export | `downloadPlan()` writes JSON with planned file names. | A reproducible zip with a manifest, tied to exact revisions and to the verification run. |
| Progress | `Project.complete` (0–5) and `needs` are counters kept in the client. | Derived on the server from backend state (see §5 "UI integration contract"). |
| Backend, DB, auth, queue, tests, CI, infra, AGENTS.md | **None exist.** `.env` exists and is gitignored. Its contents were not read. | All proposed below. |

Because there is no backend, every component below is new work. The plan stays in the current TypeScript/Next.js stack. The only departure is a separate worker process plus Linux sandbox hosts, which running untrusted binaries requires (§2, §8).

## 0. Recommended MVP architecture and first vertical slice (summary)

**MVP target:** non-interactive **Linux x86-64 ELF command-line programs** (batch: argv + stdin + input files → stdout, stderr, exit status, output files), modernized into **TypeScript on Node.js 22 LTS**, one **bounded batch workflow** (one invocation mode of the CLI) per project.

**Architecture:** a modular monolith plus isolated workers.
- **Next.js app** (existing repo): UI plus `/api/v1` Route Handlers (Node runtime). These call a shared `server/` domain layer.
- **PostgreSQL**: system of record, plus the job queue (`jobs` table claimed with `FOR UPDATE SKIP LOCKED`). No Redis.
- **S3-compatible object storage** (MinIO locally): content-addressed blobs. Uploads and downloads go through presigned URLs.
- **One worker program** (`workers/main.ts`) running several job kinds: `inspect`, `index`, `deep_analysis`, `probe`, `generate`, `build`, `capture`, `verify`, `export`.
- **A sandbox launcher on Linux worker hosts** (gVisor `runsc`, no network, cgroup limits). Every piece of untrusted work runs in it: Ghidra/REA parsing, executing the original, building and running generated code.
- **Comparison engine** as a pure TypeScript package (`packages/compare`). It is used by the verify worker and vendored into every export, so replay needs neither the product nor REA.

**First vertical slice (S1):** "One fixture, import to export, no LLM and no Ghidra." Upload the `wordfreq` ELF fixture. Built-in ELF inspection gives format, architecture, `DT_NEEDED` and strings, and sets separate analysis and execution eligibility. Then: a hand-authored scope revision is approved, a customer-supplied TypeScript replacement is uploaded and built, 10 references are captured from the original in the sandbox, verification runs, and an export zip is produced that replays in a clean `node:22` container with matching outcomes. Acceptance criteria are in §10.

## 1. Backend scope and MVP boundary

### 1.1 Choices
| Dimension | MVP choice | Why |
|---|---|---|
| Executable/runtime family | ELF64 x86-64, Linux, glibc ≤ the version in the run image, dynamically or statically linked, non-interactive CLI | Ghidra headless supports it on Linux x64 (REA docs, verified). It runs cheaply and repeatably in Linux containers under gVisor, and it can be inspected statically without running it. |
| Target language | TypeScript (strict), Node.js 22 LTS, ESM, **no third-party runtime dependencies** in MVP | Same language as the existing stack and the UI copy (`Prepare TypeScript modules`, `*.ts`). One toolchain (`tsc`) for type-checking. Tradeoff: C integer and float semantics need explicit helpers (BigInt / `Math.imul` / fixed-width wrappers). Where none were used, generation must mark the code as untranslated. |
| Workflow type | **Batch CLI transformation**: one invocation (for example `wordfreq --top N < input.txt`) whose observable behavior is argv, env allow-list, stdin and the files in the working directory → exit status, stdout, stderr, and the files created, modified or deleted in the working directory | It is observed at the process boundary, so no in-process function harnessing or emulation is needed. The same observation contract works for the original, the replacement, and exported replay. |

The replacement exposes a **typed function interface** (`run(input, deps): Promise<Output>`) plus a generated **CLI shim** (`bin/cli.mjs`). The shim maps process I/O to that interface. Verification runs the shim, so the original and the replacement are observed the same way.

### 1.2 Supported vs. unsupported inputs
- **Supported primary artifact:** one ELF64 x86-64 executable (`ET_EXEC` or `ET_DYN` with `PT_INTERP`, or static), ≤ 200 MiB.
- **Supported supporting artifacts:** shared libraries (`.so*`, matched by `DT_NEEDED` soname), data and config files placed in the working directory or at declared paths, documentation (txt/md/pdf), images and video (kept as context only). ≤ 1 GiB per revision, ≤ 500 files.
- **Accepted but analysis-only (execution `unsupported`):** ELF for other architectures (aarch64, i386), ELF needing a newer glibc than the run image, binaries that need a TTY, a GUI or X11, or network.
- **Rejected or `unsupported` (recorded, never executed):** PE/COFF, Mach-O, scripts (shebang), archives as the primary artifact (supporting archives are allowed but not extracted in MVP), kernel modules, firmware images, encrypted or packed binaries (detected heuristically; analysis may be `partial`).

### 1.3 Prerequisites
- **To analyze:** the bytes are an ELF the inspector can parse. For deep analysis, Ghidra 12.1+ with a full JDK in the analysis image (REA requirement), within time and memory limits (to be measured in spike F1).
- **To run the original:** (a) analysis eligibility is at least `partial` and the architecture is x86-64; (b) every `DT_NEEDED` library is satisfied by the run image's base libraries or by supplied artifacts; (c) the org has execution enabled and the user has acknowledged execution consent for this source revision; (d) the execution probe (a run with empty stdin, or user-specified smoke args, in the sandbox) produces a complete observation. A nonzero exit still counts as runnable.

### 1.4 When execution is unavailable
Everything except capturing references from the original still works. That covers inspection, indexing, evidence browsing, scope approval, generation, build, and **user-supplied references**: the user uploads expected outputs with a provenance attestation, for example from production logs or the legacy system's own documentation. Cases without references stay **Needs reference**. Verification still runs the replacement for them and records its observation, but the outcome is never Match. Export marks those cases as unresolved.

### 1.5 Non-goals (MVP)
Windows/PE or Wine; macOS; interactive or TTY programs; GUIs; daemons, servers and network clients; calling functions in-process inside the original binary (emulation via Unicorn/Qiling); multi-binary systems; database or external-service effects; languages other than TypeScript; automatic universal-equivalence claims; fuzzing or input generation beyond simple user-guided templates; SSO/SCIM, custom roles, approval chains with multiple approvers; billing; on-prem packaging; Hopper/IDA/JEB providers in the hosted service (license restrictions on automation and output sharing, per the REA README).

## 2. Recommended architecture

### 2.1 Components
| Component | Process | Responsibility |
|---|---|---|
| **API app** | Next.js server (`app/api/v1/**/route.ts`, `runtime = 'nodejs'`), stateless, N replicas | Auth, authorization, validation (zod), synchronous CRUD on revisions, approvals, enqueueing jobs, presigning URLs, computing staleness, serving status. It never parses or runs uploaded bytes. |
| **PostgreSQL 16** | managed or container | System of record, job queue, idempotency keys, append-only events/audit. Optional row-level security (RLS) as defense in depth (S7). |
| **Object storage** | S3 / MinIO | Content-addressed blobs `orgs/{org}/blobs/sha256/{hh}/{hash}`. Short-lived scratch prefix `orgs/{org}/staging/`. Exports under `orgs/{org}/exports/`. Bucket is private. Presigned URLs only, ≤ 10 min. |
| **Job queue** | `jobs` table + `SKIP LOCKED` claim + leases | Delivered at least once. Domain writes are idempotent (§4). |
| **Worker supervisor** | `node workers/main.ts` on Linux hosts, trusted code | Claims jobs, stages inputs into a per-job workdir, calls the sandbox launcher, uploads outputs, writes results. Holds the only DB and storage credentials on the host. |
| **Sandbox launcher** | small trusted module that invokes `runsc` (gVisor) with an OCI bundle | Fixed allow-list of image digests, mounts, limits and network=none. Its parameters come from server-side policy, never from artifact or tool content. |
| **Analysis images** | `lb-analysis@sha256:…` (Node 22 + pinned `rea-agents` + Ghidra 12.1.x + JDK 21) | Runs the REA CLI against the staged artifact. Returns JSON Evidence files through the output mount. |
| **Generation** | job in supervisor, egress only to the model API | Builds the evidence pack, calls the `CodeGenerator` adapter, validates output files. No untrusted execution. |
| **Build images** | `lb-node-build@sha256:…` (Node 22 + pinned `typescript`) | `tsc --noEmit` + emit, in the sandbox, no network. |
| **Run images** | `lb-run-glibc@sha256:…` (Debian slim pinned + libfaketime); `lb-run-node22@sha256:…` | Run the original or the replacement under the shared harness. |
| **Verification engine** | `packages/compare` (pure TS, no I/O) called by the `verify` job | Applies a versioned policy to reference and actual observations, producing structured results. |
| **Export builder** | `export` job | Assembles the package, computes the manifest and checksums, uploads the zip. |

### 2.2 Diagram
```
 Browser (existing Next.js UI)
    │  HTTPS (session cookie)            presigned PUT/GET (bytes never via API)
    ▼                                          │
 ┌──────────────────────┐   SQL    ┌─────────────┐        ┌───────────────────┐
 │ Next.js API /api/v1  │─────────▶│ PostgreSQL  │        │ S3 / MinIO        │
 │ (authz, revisions,   │◀─────────│ records +   │        │ blobs, staging,   │
 │  enqueue, staleness) │          │ jobs+events │        │ exports           │
 └──────────────────────┘          └─────▲───────┘        └────────▲──────────┘
                                         │ claim/lease/results     │ get/put (scoped)
                            ┌────────────┴─────────────────────────┴───────────┐
                            │ Worker supervisor (trusted, Linux host)           │
                            │  jobs: inspect·index·deep·probe·generate·build·   │
                            │        capture·verify·export                      │
                            │  packages/compare (pure)    CodeGenerator adapter ─┼──▶ Model API (egress-only)
                            └───────────┬───────────────────────────────────────┘
                                        │ OCI bundle: fixed image digest, ro inputs, rw /out, limits
                       ┌────────────────▼─────────────────────────────────┐
                       │ gVisor sandbox (runsc), network=none, non-root    │  ← TRUST BOUNDARY
                       │  • lb-analysis: rea CLI + Ghidra (parse untrusted)│
                       │  • lb-node-build: tsc on generated/customer code  │
                       │  • lb-run-glibc: original ELF + harness           │
                       │  • lb-run-node22: replacement CLI shim + harness  │
                       └──────────────────────────────────────────────────┘
```

### 2.3 Trust and process boundaries
1. **Browser ↔ API:** authenticated user, org-scoped authorization on every request.
2. **API ↔ storage:** the API only presigns object keys it derives itself from `(org_id, sha256)`. It never takes keys from clients.
3. **Supervisor ↔ sandbox (main boundary):** everything inside is untrusted. That includes uploaded binaries, Ghidra parsing them, REA output, generated or customer code, and program output. The sandbox has no credentials, no network, a read-only rootfs, inputs mounted read-only and a single writable output dir, and wall, CPU, memory, pids and output-size limits. The supervisor treats sandbox output as data. It validates it against zod schemas with size caps before persisting.
4. **Supervisor ↔ model API:** the prompt contains untrusted strings and pseudocode from the binary. The response is untrusted data: schema-validated file list, path allow-list, size caps. It is only ever built or executed inside the sandbox.

### 2.4 Sync vs. async
- **Synchronous (request/response):** projects, upload sessions, sealing source revisions, scope drafts and revisions, approvals, module revisions created from edits (the build runs async), creating test cases and case sets, user-supplied references, comparison policies, browsing findings and results, presigning downloads, and computing "applies to current".
- **Asynchronous (jobs):** checking upload hashes as part of inspect, inspection, indexing, deep function analysis, execution probe, generation, build, reference capture, verification, export.

### 2.5 Deployment constraint that shapes the architecture
Running untrusted ELF and parsing it with Ghidra needs **Linux hosts where we can install gVisor** (or Firecracker later). The worker tier therefore cannot be serverless functions. MVP deployment: one Linux VM (or a small node pool) running `docker compose` with `web`, `worker`, `postgres` and `minio` services, with `runsc` registered as an OCI runtime on the host. The web tier can run anywhere. The workers need about 4 vCPU and 16 GiB per host for Ghidra (to be confirmed in F1).

## 3. Domain model and persistence

Conventions: UUIDv7 primary keys. Every tenant table has `org_id NOT NULL` and composite FKs `(org_id, id)`, so a child can never point at another org's parent. Revision tables have `number int` unique per project and `parent_id`. `*_sha256` holds lowercase hex. Columns marked **immutable** are protected by a trigger (`BEFORE UPDATE … RAISE`). The ORM is Drizzle (SQL-first migrations in `server/db/migrations`).

### 3.1 Tenancy and access
```sql
organizations(id, name, execution_enabled bool default false, external_model_allowed bool default false,
              retention_days int default 365, quota jsonb, created_at)
users(id, email citext unique, display_name, idp_subject unique, created_at)
memberships(org_id, user_id, role text check (role in ('admin','editor','viewer')), created_at,
            primary key(org_id, user_id))
projects(id, org_id, name, description, objectives text, created_by, created_at, deleted_at,
         -- mutable "heads" (pointers only; targets are immutable)
         current_source_revision_id, approved_scope_revision_id, current_module_revision_id,
         current_case_set_revision_id, current_policy_id, heads_version int not null default 0)
```
Roles: `viewer` reads. `editor` creates revisions, runs jobs and approves scope (MVP; a separate approver role comes later). `admin` manages members, org settings and deletion. Head pointers change only through compare-and-swap on `heads_version`.

### 3.2 Artifacts and source revisions
```sql
blobs(org_id, sha256, size_bytes, media_type, storage_key, created_at, purge_after,
      primary key(org_id, sha256))                         -- per-org dedup only (no cross-tenant dedup side channel)
upload_sessions(id, org_id, project_id, filename, declared_size, declared_sha256, status
                check (status in ('pending','received','rejected','expired','consumed')),
                staging_key, expires_at, created_by, created_at)
source_revisions(id, org_id, project_id, number, parent_id, notes text, objectives text,
                 manifest_sha256,                       -- sha256 of canonical artifact list   [immutable]
                 execution_consent_by, execution_consent_at,   -- set-once
                 created_by, created_at)
source_artifacts(source_revision_id, org_id, path text, role check (role in
                 ('primary_executable','shared_library','data_file','documentation','media','other')),
                 blob_sha256, size_bytes,                                                      [immutable]
                 primary key(source_revision_id, path))
-- exactly one primary_executable per revision: partial unique index on (source_revision_id) where role='primary_executable'
```
A revision is created **sealed** (one transaction from completed upload sessions). Changing artifacts, notes or objectives creates a new revision with `parent_id`.

### 3.3 Analysis runs, findings, evidence
```sql
analysis_runs(id, org_id, project_id, source_revision_id, job_id,
  kind check (kind in ('inspect','index','deep_function','probe')),
  provider text,                -- 'builtin-elf' | 'rea-ghidra' | 'sandbox-probe'
  provider_version jsonb,       -- {"rea-agents":"x.y.z","ghidra":"12.1.4","jdk":"21.0.x","image":"sha256:…"}
  params jsonb, params_digest,
  outcome check (outcome in ('complete','partial','unsupported','failed')) null,   -- set once at finalize
  eligibility jsonb null,       -- inspect/probe only: {"analysis":"eligible|partial|ineligible", "execution":"runnable|not_runnable|unsupported|not_permitted", "reasons":[…]}
  coverage jsonb, limitations jsonb, unknowns jsonb,
  raw_evidence_blob_sha256,     -- full REA Evidence bundle as produced
  created_at, finished_at,
  unique(source_revision_id, kind, provider, params_digest, (provider_version->>'image')))
findings(id, org_id, source_revision_id, analysis_run_id,
  kind check (kind in ('format','dependency','section','symbol','function','string','xref','pseudocode','call_graph_edge','note')),
  stable_key text,              -- e.g. 'function:0x401136', 'string:0x402010', 'dependency:libm.so.6'
  name text, address numeric null, attributes jsonb,
  authority check (authority in ('observed_static','observed_runtime','tool_inferred','model_inferred','user_stated')),
  confidence real null,
  artifact_path text, artifact_sha256,      -- must equal a source_artifacts row of this revision
  location jsonb,                -- {file_offset, vaddr, section, length}
  provider_evidence_id text,     -- REA 'ev_<sha256>' for exact provenance back to the raw bundle
  content_blob_sha256 null,      -- large bodies (pseudocode, instruction listing)
  unique(analysis_run_id, stable_key))
-- index: (source_revision_id, kind, name gin_trgm_ops), (source_revision_id, stable_key)
```
Findings are immutable observations. The same `stable_key` from a later run (a newer tool version) is a new row. The API shows the latest successful run per kind and lets the user pick older ones.

### 3.4 Scope/interface revisions and approvals
```sql
scope_drafts(project_id primary key, org_id, base_revision_id null, document jsonb, version int, updated_by, updated_at)
scope_revisions(id, org_id, project_id, number, parent_id, source_revision_id,
                document jsonb, document_sha256, schema_version int, created_by, created_at)      [immutable]
approvals(id, org_id, scope_revision_id, document_sha256, decision check (decision in ('approved','rejected')),
          decided_by, comment, created_at,
          unique(scope_revision_id) )   -- one decision per revision; re-decide = new revision
```
`document` (zod-validated, `schema_version` 1):
```jsonc
{
  "workflow": { "name": "Top-N word frequency", "invocation": { "argv_template": ["--top", "{n}"], "stdin": "text" } },
  "inputs":  [{ "id": "n", "kind": "argv", "type": "integer", "range": [1, 1000] },
              { "id": "text", "kind": "stdin", "encoding": "utf-8|bytes" }],
  "outputs": [{ "id": "out", "kind": "stdout", "format": "lines" }, { "id": "code", "kind": "exit_status" },
              { "id": "err", "kind": "stderr" }],
  "required_state": [{ "id": "dict", "kind": "file", "path": "stopwords.txt", "mode": "read" }],
  "dependencies": [{ "id": "clock", "kind": "time", "disposition": "explicit_input",
                     "responsibility_change": "Caller now supplies 'now'; original read the system clock.",
                     "evidence": ["f_01J…"] }],
  "interface": { "language": "typescript", "export": "run",
                 "input_schema": { /* JSON Schema */ }, "output_schema": { /* JSON Schema */ },
                 "errors": [{ "code": "INVALID_N", "maps_to": { "exit_status": 2, "stderr_pattern": "usage:" } }] },
  "behaviors": [{ "id": "b1", "statement": "Words are lower-cased before counting",
                  "basis": "observed|inferred|customer_requirement|intentional_change",
                  "evidence": ["f_01J…"], "notes": "" }],
  "intentional_changes": [{ "id": "c1", "behavior": "b4", "description": "UTF-8 aware tokenization", "approved_reason": "…" }],
  "decisions": [{ "id": "d1", "text": "…", "by": "user_…", "at": "…" }],
  "assumptions": [{ "id": "a1", "text": "Input ≤ 10 MiB" }],
  "open_questions": [{ "id": "q1", "text": "Tie-break order?", "status": "open|resolved", "resolution": null }]
}
```
The server checks that every `evidence` id exists and belongs to `source_revision_id`. The four bases (observed / inferred / customer requirement / intentional change) are separate enum values. They are never merged.

### 3.5 Module revisions and builds
```sql
module_revisions(id, org_id, project_id, number, parent_id, scope_revision_id,      -- must be approved at insert
  origin check (origin in ('generated','user_edit','customer_upload')),
  target text default 'typescript-node22',
  source_tree_blob_sha256,       -- deterministic tar (sorted, mtime=0, uid=0)
  file_manifest jsonb,           -- [{path, sha256, size}]
  public_interface jsonb,        -- extracted .d.ts of entry + JSON Schemas
  dependency_manifest jsonb,     -- package.json (+ lockfile digest); MVP enforces no runtime deps
  untranslated jsonb,            -- [{id, behavior_id?, file, line, reason, evidence:[…]}]
  generator jsonb null,          -- {provider, model, model_version, template_version, params, input_digest, output_digest, transcript_blob}
  created_by, created_at)                                                                      [immutable]
build_results(id, org_id, module_revision_id, attempt int, build_image_digest, toolchain jsonb,
  status check (status in ('succeeded','failed','error')),     -- failed = compiler diagnostics; error = infra
  diagnostics jsonb, log_blob_sha256, output_blob_sha256, started_at, finished_at,
  unique(module_revision_id, build_image_digest, attempt))
```

### 3.6 Test cases, references, case sets
```sql
test_cases(id, org_id, project_id, name, input jsonb, input_digest,   -- {argv:[], env:{}, stdin_blob, files:[{path,blob_sha256,mode}], timeout_ms}
           origin check (origin in ('user','template','imported')), created_by, created_at,
           unique(project_id, input_digest))                                                    [immutable]
reference_outputs(id, org_id, test_case_id,
  provenance check (provenance in ('captured_original','user_supplied')),   -- NO replacement-derived value exists
  source_revision_id null, execution_env_id null, capture_job_id null,      -- required when captured_original
  observation jsonb,             -- {exit:{code|signal}, stdout_blob, stderr_blob, files:[{path,status,sha256}], truncated:{…}}
  repeat_count int, deterministic bool null,   -- captured N times; false ⇒ flagged
  attestation text null, supplied_by null,     -- required when user_supplied
  created_at)                                                                                   [immutable]
case_set_revisions(id, org_id, project_id, number, parent_id,
  entries jsonb,                 -- [{test_case_id, reference_output_id|null}]
  digest, created_by, created_at)                                                               [immutable]
```

### 3.7 Environments and comparison policies
```sql
execution_environments(id, name, version, role check (role in ('original','replacement','build','analysis')),
  image_digest, arch, controls jsonb,  -- {"tz":"UTC","locale":"C.UTF-8","faketime":"2000-01-01 00:00:00","aslr":"off","uid":10001,"limits":{…}}
  created_at)                          -- global, platform-managed, immutable; never edited in place
comparison_policies(id, org_id, project_id, number, parent_id, rules jsonb, digest, created_by, created_at)   [immutable]
```

### 3.8 Verification
```sql
verification_runs(id, org_id, project_id, job_id,
  source_revision_id, scope_revision_id, module_revision_id, build_result_id,
  case_set_revision_id, comparison_policy_id, replacement_env_id,
  binding jsonb, binding_digest,       -- canonical JSON of all ids + content digests above + compare engine version
  completeness check (completeness in ('complete','partial')) null,
  summary jsonb null,                  -- {match, difference, couldnt_run, needs_reference}
  created_by, created_at, finished_at)
-- unique(binding_digest) where completeness='complete'  → identical request returns the existing run
verification_results(id, org_id, verification_run_id, test_case_id, reference_output_id null,
  outcome check (outcome in ('match','difference','couldnt_run','needs_reference')),
  actual jsonb,                        -- same observation schema as reference
  raw_equal bool null, normalized boolean, normalization_trace jsonb,
  differences jsonb, diagnostics jsonb, log_blob_sha256, duration_ms,
  unique(verification_run_id, test_case_id))                                                    [immutable]
```

### 3.9 Exports, jobs, events
```sql
export_packages(id, org_id, project_id, verification_run_id, binding_digest,
  manifest jsonb, manifest_sha256, sums_sha256, package_blob_sha256, job_id, created_by, created_at, expires_at)
jobs(id, org_id, project_id, kind, subject_type, subject_id, payload jsonb, dedupe_key,
  status check (status in ('queued','running','succeeded','failed','cancelled')),
  attempt int, max_attempts int, run_after, lease_owner, lease_expires_at, heartbeat_at,
  cancel_requested_at, progress jsonb, error jsonb, created_at, started_at, finished_at,
  unique(org_id, dedupe_key) where status in ('queued','running'))
idempotency_keys(org_id, user_id, key, request_sha256, response_status, response_body jsonb, created_at,
  primary key(org_id, user_id, key))   -- 24 h TTL
events(id bigserial, org_id, project_id null, actor_id null, type, subject_type, subject_id, data jsonb, created_at)
  -- append-only; serves both the audit log and the UI activity cursor
```

### 3.10 Immutability, lineage, isolation, retention, deletion
- **Immutability:** the tables marked above reject `UPDATE`/`DELETE` through triggers. The only exception is the purge procedure, which runs as a separate DB role. Mutable state is limited to drafts, `projects` head pointers, `jobs`, and set-once finalization columns (`outcome`, `completeness`, `summary`, `finished_at`, guarded by `WHERE outcome IS NULL`).
- **Lineage:** each derived row stores FKs to its exact parent revisions. Verification and export store a `binding` with content digests, so lineage survives even if a row were tampered with.
- **Tenant isolation:** every query goes through a repository layer that requires an `OrgContext`. Composite `(org_id, id)` FKs. Blob keys prefixed by org. Per-org blob dedup only. Postgres RLS (`USING org_id = current_setting('app.org_id')::uuid`) added in S7 as defense in depth. Cross-org access returns 404, never 403.
- **Retention:** staging uploads 24 h. Sandbox workdirs deleted when the job ends. Job logs and transcripts 90 d. Revisions, findings, results and manifests live as long as the project. Export zips expire after 30 d (the manifest row is kept and the zip can be rebuilt from the same binding). Raw REA bundles live as long as the project.
- **Deletion:** project delete → `deleted_at` tombstone (hidden immediately, jobs cancelled) → purge job after a 7-day grace period deletes rows and then blobs no longer referenced by any project in the org. Org deletion purges everything. Audit `events` rows are kept, with `data` reduced to ids.

## 4. State machines and invariants

### 4.1 Separate status dimensions (never collapsed into one field)
| Dimension | Values | Lives on |
|---|---|---|
| Job status | `queued → running → succeeded \| failed \| cancelled` | `jobs.status` |
| Analysis eligibility | `unknown \| eligible \| partial \| ineligible` (+ reason codes) | latest `inspect`/`index` run's `eligibility.analysis` |
| Execution eligibility | `unknown \| runnable \| not_runnable \| unsupported \| not_permitted` (+ reasons such as `missing_library:libfoo.so.1`, `arch:aarch64`, `consent_missing`) | latest `inspect` (static check) refined by `probe` |
| Analysis outcome | `complete \| partial \| unsupported \| failed` | `analysis_runs.outcome` |
| Build status | `not_built \| building \| succeeded \| failed \| error` | derived from `build_results` + active build job |
| Reference availability (per case-set entry) | `needs_reference \| captured_original \| user_supplied` (+ `deterministic=false` flag) | `case_set_revisions.entries` + `reference_outputs` |
| Comparison outcome (per case) | `match \| difference \| couldnt_run \| needs_reference` | `verification_results.outcome` |
| Run completeness | `complete \| partial` | `verification_runs.completeness` |
| Applicability | `applies_to_current: bool` + `stale_reasons[]` | **computed on read**, never stored |

A job can `succeed` with analysis outcome `partial`. A job can `fail` (infra) while the source stays `eligible`. A succeeded verification job can contain zero matches.

### 4.2 Lifecycles
**Job** (all long-running workflows):
```
queued ──claim(lease)──▶ running ──ok──▶ succeeded
   │                       │ ├─transient error & attempt<max──▶ queued (run_after = backoff)
   │                       │ ├─permanent error / attempts exhausted──▶ failed
   │                       │ └─cancel_requested observed──▶ cancelled
   └─cancel──▶ cancelled   └─lease expired (worker crash)──▶ reaper: queued (attempt+1) or failed(worker_lost)
```
**Upload session:** `pending → received` (S3 verified the checksum against `declared_sha256`) `→ consumed` (sealed into a revision). `pending → expired` after 1 h. `received → rejected` (size or quota exceeded). The inspect job recomputes the SHA-256 independently. On a mismatch the run outcome is `failed` with `hash_mismatch`, and the revision is flagged.

**Source revision:** created sealed. Eligibility evolves only by appending runs: `inspect` sets static analysis and execution eligibility, `index` may downgrade analysis to `partial`, and `probe` moves execution from `unknown` to `runnable`/`not_runnable`.

**Scope:** `draft` (mutable, `version`) `→ revision` (immutable, created from a draft at version V) `→ approval decision` (`approved | rejected`, at most one per revision). The project's `approved_scope_revision_id` moves only by CAS. A new approval supersedes the old one by changing the head pointer. Superseded is derived, never stored.

**Module revision:** inserted immutable → a build job is enqueued automatically (`not_built → building → succeeded | failed | error`). Each edit or regeneration is a new module revision. A rebuild of the same revision is a new `attempt`.

**Reference capture:** a job per (case-set entry list, source revision, env). Per case: run `repeat_count` (default 2) times → `captured` (deterministic) | `captured_nondeterministic` (stored, `deterministic=false`, cannot yield Match unless the policy has an explicit rule for the differing channel) | `couldnt_run` (no reference written). New references are attached by creating a **new case-set revision**, never by mutating an old one.

**Verification run:** row created with its binding at enqueue time. Results are written per case as they finish (idempotent upsert on `(run_id, test_case_id)`, insert-only: on conflict do nothing). At finalize: `completeness = complete` if all entries have results, otherwise `partial` (cancelled or failed midway). The summary is computed from the results.

**Export:** `queued → running → succeeded (package ready) | failed`. Ready packages expire (blob deleted, manifest kept) and can be rebuilt from the same binding.

### 4.3 Failure and concurrency behavior
| Situation | Behavior |
|---|---|
| **Retries** | Only for `retryable` error classes (storage 5xx, sandbox start failure, model API 429/5xx). Exponential backoff with jitter. `max_attempts`: 3 (generation 2). Program behavior (nonzero exit, crash, timeout of the *program*) is an observation, not a retryable error. |
| **Timeouts** | Job-level wall clock per kind (index 20 min, generate 10 min, verify 30 min, per-case 10 s default / 60 s max). A per-case timeout → `couldnt_run{reason:"timeout"}`. It does not fail the job. |
| **Cancellation** | `POST /jobs/:id/cancel` sets `cancel_requested_at`. The worker checks between steps or cases (≤ 2 s polling via heartbeat), kills the sandbox, writes completed results, and finalizes `cancelled` with run `completeness=partial`. A queued job is cancelled immediately. |
| **Worker crash** | Heartbeat every 10 s extends `lease_expires_at` by 45 s. A reaper (in every worker, every 15 s) requeues expired leases (`attempt+1`) or fails them with `worker_lost`. Orphan sandboxes are labelled `lb.job=<id>` and killed by the host reaper when the job is no longer `running` under that host. |
| **Duplicate delivery** | Claim uses `UPDATE … WHERE id=$1 AND status='queued'` / `SKIP LOCKED`. All writes check `lease_owner = $me` on finalize. Result rows have natural unique keys, so a second worker's writes become no-ops and its finalize affects 0 rows, after which it aborts. |
| **Duplicate requests** | `Idempotency-Key` header on every POST (replay returns the stored response; the same key with a different body returns `409 idempotency_key_reused`). Natural dedupe as well: an active job with the same `dedupe_key` (for example `verify:<binding_digest>`) is returned instead of enqueueing a new one. A complete verification with the same binding is returned with `reused: true` unless `force_rerun: true`. |
| **Concurrent edits** | Scope draft `PUT` requires `If-Match: "v<version>"` → `412 precondition_failed` with the current version. Head pointer moves use CAS on `projects.heads_version`. Module edits name `parent_id`. If the parent is not the current head, the edit is still accepted as a new revision (a branch), but `current_module_revision_id` moves only if `parent_id` was the head, or with an explicit `make_current: true` that names the expected head. |
| **Concurrent approvals** | Approval names `scope_revision_id` + `document_sha256`. A digest mismatch → 409. `unique(scope_revision_id)` makes a second decision fail with `409 already_decided`. Moving the head checks the expected previous head. |
| **Partial completion** | Analysis may finish `partial` with `coverage`/`unknowns`. Verification may finish `partial`. Both are shown explicitly and never rounded up. An export of a partial run is allowed only with `allow_partial: true`, and the manifest records it. |
| **New revisions during an active run** | The run keeps its bound revisions and completes. It is not cancelled automatically. The UI receives `applies_to_current=false` once heads move. Optional `supersede: true` on the new request cancels older active runs for the same project and kind. |
| **Results no longer current** | `applies_to_current` = every bound id equals the corresponding project head **and** the bound build is the latest succeeded build of that module **and** the policy and env ids are current. `stale_reasons` lists each mismatch (`module_revision_changed`, `scope_reapproved`, `case_set_changed`, `policy_changed`, `source_changed`). Project progress counts a step as verified only from a run where `applies_to_current=true`. |

### 4.4 Invariants (enforced by the backend regardless of UI)
1. Immutable rows (source artifacts, scope revisions, module revisions, test cases, reference outputs, case sets, policies, environments, verification results, export manifests) are never updated or deleted outside the purge role.
2. Each source revision has exactly one primary executable. Every finding's `artifact_sha256` equals an artifact of its revision.
3. A module revision can be created only against an **approved** scope revision of the same project. Generation reads the approved revision by id, never the draft.
4. A verification run binds the exact ids **and content digests** of source, scope, module, build result, case-set revision, comparison policy, replacement environment, and the compare-engine version. The binding is immutable once created.
5. Results are never mutated or copied to another run. A changed input means a new run. `applies_to_current` is computed on read and never stored.
6. Only `captured_original` and `user_supplied` references exist. Nothing derived from the replacement can be stored as a reference (enum plus API validation). An entry with no reference produces `needs_reference` and can never produce `match`.
7. `match` requires a complete observation on both sides. A reference with `deterministic=false` yields `match` only when the policy explicitly covers every channel that varied.
8. `couldnt_run` means no complete observation exists for the replacement (build missing or failed, sandbox or harness error, timeout, resource-limit kill, truncated output). A nonzero exit, signal or exception from either program **is** an observation and is compared.
9. Normalizers are applied symmetrically to both sides, identified by `id@version`, recorded in a per-result `normalization_trace`, and every result keeps both raw digests and `raw_equal`.
10. Captured references record the source revision and execution environment that produced them. Execution happens only when `organizations.execution_enabled` and per-revision consent are both present.
11. Every row and object is org-scoped. No API path returns or presigns another org's object.
12. Uploaded artifacts, tool output and model output never set execution policy (image, mounts, limits, network, env beyond the case's allow-listed env). Those come only from server-side environment records.
13. Exports are produced only from a finalized verification run. `SHA256SUMS` covers every file, including the manifest (except the non-semantic `EXPORT_ID`), and the package records `completeness` and `applies_to_current` at build time.

## 5. UI-facing API contracts

REST + JSON under `/api/v1`. Shared zod schemas live in `packages/contracts`, so the UI and the API agree on types.

### 5.1 Cross-cutting
- **Authentication:** OIDC login through Auth.js (NextAuth v5) with an HTTP-only, SameSite=Lax session cookie. The active org is selected by an `X-Org-Id` header or the path. Mutating requests require a CSRF token (Auth.js double-submit cookie). S1 uses a dev-only single-org credentials provider behind `NODE_ENV!=='production'`.
- **Authorization:** `requireRole(ctx, 'viewer'|'editor'|'admin')` in each handler, plus repository-level org scoping. Execution endpoints also check `org.execution_enabled`. Generation checks `org.external_model_allowed`.
- **Idempotency:** `Idempotency-Key: <uuid>` is required on every POST that creates a resource or a job (§4.3).
- **Concurrency:** `ETag`/`If-Match` on drafts and head moves. Revisions are created by naming `parent_id` / `base_version`.
- **Pagination:** cursor-based, `?limit=50&cursor=<opaque>` → `{ "items": [...], "next_cursor": "…" | null }`. Stable order by `(created_at, id)` or `(stable_key)` for findings.
- **Downloads:** `GET /api/v1/projects/:pid/blobs/:sha256` checks that the blob is referenced inside this project, then returns `302` to a presigned GET (5 min) with `Content-Disposition: attachment` and `Content-Type: application/octet-stream`. Untrusted bytes are never rendered inline. Small text (≤ 256 KiB, for example a stdout excerpt) is returned inline as JSON strings with an `encoding` (`utf-8`/`base64`).
- **Errors:** `application/problem+json` (RFC 9457):
```json
{ "type": "https://legacybridge.dev/errors/execution_not_permitted", "title": "Execution not permitted",
  "status": 409, "code": "execution_not_permitted",
  "detail": "This organization has not enabled running uploaded executables.",
  "action": { "kind": "enable_setting", "setting": "execution_enabled", "role_required": "admin" },
  "retryable": false, "request_id": "req_01J…", "fields": null }
```
  Job failures use the same shape in `jobs.error`, plus a `diagnostics_blob` link.
- **Progress:** **polling**. The existing UI has no data-fetching layer, no websocket or SSE infrastructure, and no long-lived screens. Jobs last seconds to minutes. Polling works behind any proxy and on serverless web tiers. The UI polls `GET /projects/:pid/activity?after=<cursor>` every 2 s while any job is active (5 s backoff when idle), plus `GET /jobs/:id` on detail views. Both return `ETag` → `304`. SSE (`/activity/stream` backed by `LISTEN/NOTIFY`) is a later optimization with the same event payloads.

### 5.2 Endpoints (representative payloads)
**Projects**
```http
POST /api/v1/projects            {"name":"Wordfreq","description":"Top words","objectives":"Replace nightly batch tool"}
→ 201 {"id":"prj_…","name":"Wordfreq","progress":{"stage":"import","completed_steps":0,"needs_input":[]},"heads":{…}}
GET  /api/v1/projects?cursor=    GET/PATCH/DELETE /api/v1/projects/:pid
```
**Uploads and source revisions (Import)**
```http
POST /api/v1/projects/:pid/uploads
{"filename":"wordfreq","size":18432,"sha256":"9f2c…"}
→ 201 {"upload_id":"upl_…","method":"PUT","url":"https://s3…","headers":{"x-amz-checksum-sha256":"<base64>","content-type":"application/octet-stream"},"expires_at":"…"}

POST /api/v1/uploads/:uid/complete          → 200 {"status":"received"}   (server HEADs object, checks size/checksum)

POST /api/v1/projects/:pid/source-revisions
{"parent_id":null,"artifacts":[{"upload_id":"upl_a","path":"bin/wordfreq","role":"primary_executable"},
                               {"upload_id":"upl_b","path":"stopwords.txt","role":"data_file"}],
 "notes":"Runs nightly via cron","objectives":"Same output for the report pipeline"}
→ 201 {"id":"src_…","number":1,"manifest_sha256":"…","artifacts":[{"path":"bin/wordfreq","sha256":"9f2c…","size":18432,"role":"primary_executable"}],
       "jobs":[{"id":"job_insp","kind":"inspect"},{"id":"job_idx","kind":"index"}]}

GET /api/v1/source-revisions/:sid
→ 200 {"id":"src_…","eligibility":{"analysis":{"status":"eligible","run_id":"anr_…"},
        "execution":{"status":"unknown","reasons":["probe_not_run"],"static_check":"libraries_satisfied"}},
       "inspection":{"format":"ELF64","arch":"x86-64","type":"ET_DYN","interpreter":"/lib64/ld-linux-x86-64.so.2",
                     "needed":["libc.so.6"],"stripped":true,"hardening":{"pie":true,"nx":true,"relro":"full"}},
       "runs":[{"id":"anr_…","kind":"index","job_status":"running","outcome":null,"provider":"rea-ghidra","provider_version":{…}}]}

POST /api/v1/source-revisions/:sid/execution-consent   {"acknowledge":"I am authorized to run this executable in an isolated sandbox"}
POST /api/v1/source-revisions/:sid/probe               {"argv":[], "stdin_text":""}   → 202 {"job_id":"job_…"}
POST /api/v1/source-revisions/:sid/analysis-runs       {"kind":"deep_function","params":{"address":"0x401136"}} → 202 {"run_id":"anr_…","job_id":"job_…"}
```
**Evidence browsing (Select)**
```http
GET /api/v1/source-revisions/:sid/findings?kind=function&q=count&limit=50&cursor=
→ 200 {"items":[{"id":"f_01J…","kind":"function","stable_key":"function:0x401136","name":"FUN_00401136","address":"0x401136",
        "authority":"tool_inferred","attributes":{"size":214,"callers":1,"callees":["strtok","qsort"]},
        "provenance":{"run_id":"anr_…","provider":"rea-ghidra","provider_version":{"rea-agents":"…","ghidra":"12.1.4"},
                      "artifact_path":"bin/wordfreq","artifact_sha256":"9f2c…","location":{"vaddr":"0x401136","file_offset":"0x1136"},
                      "provider_evidence_id":"ev_3b1…"}}],
       "next_cursor":"…","coverage":{"status":"complete","limitations":[]}}
GET /api/v1/findings/:fid                    (includes content link for pseudocode/instructions)
GET /api/v1/source-revisions/:sid/candidates → ranked entry points/workflows: [{"title":"main → FUN_00401136 (reads stdin, qsort, printf)", "findings":[…], "signals":["reads_stdin","writes_stdout"]}]
```
**Scope (Select)**
```http
GET /api/v1/projects/:pid/scope-draft        → 200 ETag:"v7" {"version":7,"base_revision_id":null,"document":{…}}
PUT /api/v1/projects/:pid/scope-draft        If-Match:"v7" {"document":{…}} → 200 ETag:"v8" | 412 | 422 {fields:[{"path":"behaviors[2].evidence[0]","code":"unknown_finding"}]}
POST /api/v1/projects/:pid/scope-revisions   {"from_draft_version":8} → 201 {"id":"scp_…","number":3,"document_sha256":"…"}
POST /api/v1/scope-revisions/:rid/decision   {"decision":"approved","document_sha256":"…","comment":"OK"}
→ 200 {"approved_scope_revision_id":"scp_…","heads_version":12} | 409 already_decided | 409 digest_mismatch
```
**Modules (Modernize)**
```http
POST /api/v1/projects/:pid/module-revisions
{"origin":"generated","scope_revision_id":"scp_…","generator":{"provider":"codex","model":"cli-default"}}
→ 202 {"job_id":"job_gen"}            (job creates the module revision, then enqueues build)

POST /api/v1/projects/:pid/module-revisions
{"origin":"user_edit","parent_id":"mod_…","changes":[{"path":"src/tokenize.ts","content":"…"},{"path":"src/old.ts","delete":true}]}
→ 201 {"id":"mod_…","number":5,"build":{"status":"building","job_id":"job_b"},"is_current":true}

POST /api/v1/projects/:pid/module-revisions  {"origin":"customer_upload","scope_revision_id":"scp_…","upload_id":"upl_tar"}
GET  /api/v1/module-revisions/:mid           → files manifest, public_interface, untranslated[], generator, latest build
GET  /api/v1/module-revisions/:mid/files/*path   → {"path":"src/index.ts","encoding":"utf-8","content":"…"}
GET  /api/v1/module-revisions/:mid/builds    → [{"attempt":1,"status":"failed","diagnostics":[{"file":"src/index.ts","line":12,"code":"TS2322","message":"…"}]}]
```
**Cases and references (Verify)**
```http
POST /api/v1/projects/:pid/test-cases
{"name":"top3 basic","input":{"argv":["--top","3"],"stdin":{"text":"a b a c a b"},"files":[{"path":"stopwords.txt","upload_id":"upl_b"}],"env":{},"timeout_ms":5000}}
POST /api/v1/projects/:pid/reference-captures
{"source_revision_id":"src_…","environment_id":"env_orig_glibc_v1","test_case_ids":["tc_1","tc_2"],"repeat":2}
→ 202 {"job_id":"job_cap"}   (on success, creates case-set revision N+1 binding new references; response of job lists it)
POST /api/v1/test-cases/:tcid/reference-outputs
{"provenance":"user_supplied","observation":{"exit":{"code":0},"stdout":{"text":"a 3\nb 2\nc 1\n"},"stderr":{"text":""}},
 "attestation":"Copied from 2019 production run log, ticket OPS-112"}
POST /api/v1/projects/:pid/case-set-revisions
{"parent_id":"cs_…","set":[{"test_case_id":"tc_1","reference_output_id":"ref_9"},{"test_case_id":"tc_3","reference_output_id":null}]}
POST /api/v1/projects/:pid/comparison-policies   {"parent_id":null,"rules":{…see §7.5…}}
```
**Verification**
```http
POST /api/v1/projects/:pid/verification-runs
{"module_revision_id":"mod_5","case_set_revision_id":"cs_4","comparison_policy_id":"pol_2","environment_id":"env_node22_v1"}
→ 202 {"run_id":"vr_…","job_id":"job_…","reused":false,"binding_digest":"…"}
GET /api/v1/verification-runs/:vrid
→ 200 {"id":"vr_…","job_status":"succeeded","completeness":"complete",
       "summary":{"match":7,"difference":1,"couldnt_run":0,"needs_reference":2},
       "binding":{"source_revision":{"id":"src_1","manifest_sha256":"…"},"scope_revision":{"id":"scp_3","sha256":"…"},
                  "module_revision":{"id":"mod_5","tree_sha256":"…"},"build":{"id":"bld_…","image":"sha256:…"},
                  "case_set":{"id":"cs_4","digest":"…"},"policy":{"id":"pol_2","digest":"…"},
                  "environment":{"id":"env_node22_v1","image":"sha256:…"},"compare_engine":"1.0.0"},
       "applies_to_current":false,"stale_reasons":["module_revision_changed"],
       "limitations":["2 cases have no independent reference","filesystem observed only under working directory"]}
GET /api/v1/verification-runs/:vrid/results?outcome=difference&cursor=
GET /api/v1/verification-results/:id   → differences, normalization_trace, raw digests, diagnostics, log link
```
**Export, jobs, activity**
```http
POST /api/v1/projects/:pid/exports {"verification_run_id":"vr_…","include_original_binary":false,"allow_partial":false}
→ 202 {"export_id":"exp_…","job_id":"job_…"}
GET  /api/v1/exports/:eid → {"status":"ready","manifest_sha256":"…","sums_sha256":"…","download_url":"/api/v1/exports/exp_…/download","expires_at":"…"}
GET  /api/v1/jobs/:jid    → {"id":"job_…","kind":"verify","status":"running","attempt":1,
                             "progress":{"phase":"running_cases","completed":6,"total":10,"message":"case tc_7"},"error":null}
POST /api/v1/jobs/:jid/cancel → 202 {"status":"cancel_requested"}
GET  /api/v1/projects/:pid/activity?after=evt_123 → {"items":[{"id":"evt_124","type":"job.progress","subject":{"type":"job","id":"job_…"},"data":{…}}],"next_cursor":"evt_124"}
```

### 5.3 UI workflow → backend operations
| UI step (existing component) | Backend operations |
|---|---|
| Picker (`Picker.tsx`) list/create/delete | `GET/POST/DELETE /projects`. Card progress comes from `project.progress` (replaces `complete`/`needs`). |
| **Import** (`Workflow` stage 0 + `ContextPanel`) | `POST /uploads` → PUT → `/complete` (per file) → `POST /source-revisions` → poll `activity` → `GET /source-revisions/:sid` for eligibility. Then `execution-consent` + `probe` if the user wants references from the original. "Start" is enabled when analysis eligibility ≠ `unknown`. |
| **Select** (stage 1) | `GET /candidates`, `GET /findings`, `GET /findings/:id`, `PUT /scope-draft`, `POST /scope-revisions`, `POST /decision`, optional `POST /analysis-runs` (deep function). The current feature checkboxes map to `behaviors[]`/candidate selection. |
| **Modernize** (stage 2) | `POST /module-revisions` (generated / edit / upload), `GET /module-revisions/:mid`, `/files`, `/builds`. |
| **Verify** (stage 3) | `POST /test-cases`, `POST /reference-captures`, `POST /reference-outputs`, `POST /case-set-revisions`, `POST /comparison-policies`, `POST /verification-runs`, `GET /verification-runs/:id`, `/results`. The table's "Tool / Test" rows become cases × outcomes. |
| **Export** (stage 4) | `POST /exports`, `GET /exports/:eid`, download. |

**UI integration contract (minimal frontend change, no redesign):** replace `loadProjects()`/`commit()` localStorage persistence and IndexedDB attachments with API calls. Change the Import drop-zone copy from "Upload code" to "Upload executable". Derive `stage` access from `project.progress.completed_steps`. The prototype's `needs` maps to `progress.needs_input: [{step:"verify", code:"needs_reference", count:2}]`.

## 6. Analysis and generation integration

### 6.1 Analysis adapter
```ts
// workers/analysis/provider.ts
export type AnalysisOp =
  | { kind: 'inspect' }                                   // format, arch, deps, hardening
  | { kind: 'index'; limits: { functions: number; strings: number } }  // functions, strings, names, xrefs summary
  | { kind: 'deep_function'; address: string };           // dossier, pseudocode, instructions, refs

export interface AnalysisProvider {
  readonly id: 'builtin-elf' | 'rea-ghidra' | string;
  version(ctx: SandboxCtx): Promise<Record<string, string>>;          // recorded on every run
  supports(op: AnalysisOp, inspection: InspectionFacts | null): Support; // 'yes' | 'no' | 'partial' + reason
  run(op: AnalysisOp, input: { artifactPath: string; sha256: string }, ctx: SandboxCtx): Promise<AnalysisOutput>;
}
export interface AnalysisOutput {
  outcome: 'complete' | 'partial' | 'unsupported' | 'failed';
  findings: NormalizedFinding[];             // see below; validated + size-capped by supervisor
  coverage: { status: 'complete' | 'page' | 'partial' | 'unknown'; examined?: number; total?: number };
  limitations: string[]; unknowns: { id: string; text: string }[];
  rawBundlePath?: string;                    // provider's original Evidence, stored verbatim as a blob
  eligibility?: { analysis: AnalysisEligibility; execution?: ExecutionEligibility; reasons: string[] };
}
export interface NormalizedFinding {
  kind: FindingKind; stableKey: string; name?: string; address?: string;
  authority: 'observed_static' | 'tool_inferred';         // providers can never emit user/model authority
  confidence?: number; attributes: Record<string, unknown>;
  location: { artifactSha256: string; artifactPath: string; vaddr?: string; fileOffset?: string; section?: string; length?: number };
  providerEvidenceId?: string;               // REA 'ev_…'
  contentPath?: string;                      // large body file in /out, uploaded as blob
}
```
**Provenance chain:** finding → `analysis_run` (provider, exact versions, image digest, params digest) → `raw_evidence_blob` (verbatim REA bundle, where `provider_evidence_id` resolves) → `source_artifact` (path + sha256) → `blob`. Scope behaviors, generation inputs and untranslated items cite finding ids. Findings are never edited. User or model claims live in the scope document with `basis` and cite findings.

### 6.2 What REA provides vs. what we build vs. unknowns
| Capability | Available in REA (checked in its docs, 2026-11-14) | We must build | Unknown / spike |
|---|---|---|---|
| ELF static facts | `inspect-elf-notes`, binary hardening (PIE/NX/RELRO), `inspect-native-initializers`, `inspect-elf-unwind-ranges`, built in, no Ghidra | `builtin-elf` parser for header/arch/`PT_INTERP`/`DT_NEEDED`/section list (small, deterministic, needed for eligibility without Ghidra). Never run `ldd`, which can execute the binary. | Whether REA has a single command returning `DT_NEEDED` (not confirmed; our parser covers it). |
| Function inventory | `rea search PATH <pattern> --kind procedures --provider ghidra --json`, MCP `list_procedures`/`search_procedures` with `detail:"summary"` + `inspect-analysis-view` paging | Mapping to `findings(kind=function)`, row caps, pagination | The exact CLI form of an unfiltered *list* of procedures (MCP `list_procedures` is documented; the CLI equivalent is not confirmed). Fallback: run `rea mcp` over stdio inside the sandbox and call `open_binary` → `list_procedures`. |
| Strings, names | MCP `list_strings`, `search_strings`, `list_names` | Same mapping | CLI command names for strings (spike F1). |
| Xrefs / call graph | `rea xrefs`, `rea procedure-references --direction incoming --detail summary --evidence_output`, `rea trace` | `call_graph_edge` findings, candidate ranking (reads_stdin/writes_stdout heuristics from imports and xrefs) | Size and time on larger binaries |
| Decompile / dossier | `rea decompile PATH ADDR --provider ghidra --json`, `rea function`, `rea instructions` | Storing pseudocode as a content blob, evidence packs for generation | Pseudocode quality on stripped, optimized code |
| Caching | `--snapshot FILE` reuses results when target bytes + op + params + provider + settings match | Persist the snapshot file as a blob per (revision, provider version) and restore it before deep ops | Whether `ev_` ids are stable across identical reruns (affects dedupe; we do not depend on it) |
| Evidence model | Records with `evidence_id`, `subject`, `provider`, `authority`, `confidence`, `limitations`, `unknowns`, coverage; `evidence-export`, `compare` | Normalization into `findings`; storing the raw bundle verbatim | Schema stability across REA releases (the README says it "changes quickly"). **Pin an exact `rea-agents` version + Ghidra 12.1.x in the image digest.** Contract tests per upgrade. |
| Process capture | `capture-process` / `compare-process-captures`: PTY, timed input, fs snapshots, versioned normalization, **"This is not a sandbox"** | Our own pipe-based harness (separate stdout/stderr, byte-exact stdin, no PTY line discipline) and our comparison engine, which must also run inside exports without REA | Optional later: also emit REA capture Evidence inside the sandbox for TTY programs (non-goal for MVP) |
| Hosted operation | CLI is a one-shot process per invocation. MCP over stdio or a one-client HTTP listener | Supervisor orchestration, timeouts, retries, persistence. REA is never a long-lived shared service. | Ghidra cold-start time per invocation (snapshot mitigates). |

**Unsupported or incomplete analysis** is represented as `outcome: 'unsupported' | 'partial'`, with `coverage`, `limitations`, `unknowns` and reasons (for example `format:pe32`, `ghidra_timeout`, `coverage:page`). The UI shows these verbatim. Absence of findings is never treated as evidence of absence unless coverage is `complete`.

### 6.3 Generation adapter
```ts
export interface CodeGenerator {
  describe(): { provider: string; model: string; modelVersion?: string };
  generate(req: GenerationRequest, ctx: { signal: AbortSignal; deadline: number }): Promise<GenerationResult>;
}
export interface GenerationRequest {
  templateVersion: 'ts-cli-v1';
  scope: { id: string; sha256: string; document: ScopeDocV1 };   // approved revision only
  evidence: { findingId: string; kind: string; artifactSha256: string; location: object; excerpt: string }[]; // capped (≤ 200 KB)
  target: { language: 'typescript'; runtime: 'node22'; entry: 'src/index.ts'; export: 'run'; allowRuntimeDeps: false };
  priorRevision?: { id: string; files: { path: string; content: string }[]; buildDiagnostics?: object[] }; // regeneration / repair
}
export interface GenerationResult {
  files: { path: string; content: string }[];       // validated: under src/ or test/, ≤ 50 files, ≤ 512 KB total
  untranslated: { id: string; behaviorId?: string; file: string; line: number; reason: string; evidence: string[] }[];
  notes: string; usage: { inputTokens: number; outputTokens: number };
  transcript: unknown;                               // stored as blob for audit, never as system of record
}
```
- **Provider:** Signed-in Codex CLI with a JSON output schema. The worker selects the model. Each generation and repair starts a fresh session built from persisted scope, evidence, and any prior files and build diagnostics. The database and blobs are the system of record.
- **Inputs:** only the approved scope revision (by id + digest) and evidence excerpts chosen by the supervisor (the findings cited by scope behaviors, plus the decompiled bodies of the selected candidate functions and their direct callees).
- **Outputs:** the supervisor writes the CLI shim and `package.json`/`tsconfig.json` from templates. The model writes only `src/**`. Path traversal, symlinks, files outside the allow-list, or any `import` of a non-`node:` module → rejected (`generation_output_invalid`), shown to the user, and the generation job fails without creating a revision.
- **Untranslated behavior:** the model must emit both the structured list and `/* LB-UNTRANSLATED:<id> */` markers. The build worker cross-checks them: unlisted markers or listed ids without markers become build *warnings*. Scope behaviors not referenced by any `LB-BEHAVIOR:<id>` marker and not listed as untranslated are reported as `unaddressed_behaviors`.
- **Build failures:** `build_results.status='failed'` with parsed `tsc` diagnostics (file, line, code, message). Verification of a module without a succeeded build is refused up front with `409 build_required`, so it does not produce a run full of "couldn't run".
- **Recorded versions:** `module_revisions.generator` = `{provider, model, model_version (from response), template_version, params, input_digest (sha256 of canonical request), output_digest, transcript_blob}`. Analysis runs record `rea-agents`, Ghidra, JDK and image digests.
- **Data handling:** generation sends pseudocode and strings to the model provider. It is gated by `organizations.external_model_allowed`. When disabled, Modernize supports customer upload and editing only.

## 7. Execution and verification design

### 7.1 Observation contract (shared by original, replacement, and exported replay)
**Case input** (`test_cases.input`):
```json
{ "argv": ["--top", "3"], "env": { "WORDFREQ_MODE": "strict" }, "stdin_blob": "sha256:…",
  "files": [{ "path": "stopwords.txt", "blob": "sha256:…", "mode": "0644" }], "timeout_ms": 5000 }
```
**Observation** (reference and actual):
```json
{ "exit": { "code": 0, "signal": null },
  "stdout": { "sha256": "…", "size": 18, "blob": "sha256:…" }, "stderr": { "sha256": "…", "size": 0 },
  "files": [{ "path": "out/report.csv", "status": "created", "sha256": "…", "size": 120 }],
  "truncated": { "stdout": false, "stderr": false, "files": false },
  "resources": { "wall_ms": 41, "max_rss_kb": 2100 }, "complete": true }
```
`resources` is diagnostic only and never compared.

### 7.2 Harnesses
- **Runner** (`workers/execution/harness`, a static binary or a Node script in each run image, identical across images): creates `/work` (tmpfs) and writes case files with their modes. Then it `execve`s the target with exact argv, a **clean env** (the allow-listed controls plus `case.env` only), stdin from a file, and stdout/stderr to separate files capped at 8 MiB each. It waits with a timeout. Afterwards it walks `/work` (depth ≤ 8, ≤ 1,000 entries, hash budget 64 MiB) to classify created, modified and deleted entries against the pre-run snapshot, and writes `observation.json` to `/out`.
- **Original:** `lb-run-glibc` image. Executable at `/opt/legacy/bin/<name>`, supplied `.so` files at `/opt/legacy/lib` (`LD_LIBRARY_PATH`), declared data files placed in `/work` per the scope's `required_state`. cwd=`/work`.
- **Replacement:** `lb-run-node22` image. Build output mounted read-only at `/opt/module`. The target is `node /opt/module/bin/cli.mjs …`. The shim parses argv, reads stdin, builds `deps` (`now`, `random`, `fs` rooted at cwd, `env`), calls `run()`, writes stdout/stderr, and sets `process.exitCode`. Uncaught exceptions → exit 70 + stderr. That is an observation, not a `couldnt_run`.

### 7.3 Environment, dependencies, state reset, controls
- **Provisioning:** environments are platform-built images pinned by digest. Customer dependencies come only from source-revision artifacts. No package installs at run time. A `DT_NEEDED` soname not satisfied by the image or the artifacts → execution `not_runnable{missing_library}` before any run.
- **State reset:** each case runs in a fresh sandbox with a fresh tmpfs `/work`, so nothing is shared between cases. Stateful *sequences* (MVP-supported limited form): a case may declare `"steps": [case input…]` executed in the same `/work`, with the observation recorded per step. Pre-state is expressed as initial `files`.
- **Controls** (recorded in `execution_environments.controls` and in every observation):

| Control | Original | Replacement | Limits |
|---|---|---|---|
| Time | `libfaketime` `LD_PRELOAD`, `FAKETIME="@2000-01-01 00:00:00"`, `FAKETIME_DONT_RESET=1` | `deps.now()` returns the same instant (`LB_FAKE_NOW`) | Static binaries and raw syscalls bypass faketime. The probe checks this (spike F2). Status `time_control: enforced \| best_effort \| none`. |
| Randomness | Cannot be seeded externally. Detected by repeat capture (N=2, more for flagged cases) | `deps.random` seeded from `LB_SEED` | Nondeterministic references are flagged, never silently matched. |
| ASLR | `setarch -R` (`ADDR_NO_RANDOMIZE`), if gVisor honors it (F2) | n/a | Addresses printed by the program remain a nondeterminism source. |
| Locale/TZ | `LC_ALL=C.UTF-8`, `TZ=UTC`, fixed `HOME=/work/.home`, `USER=lb`, hostname `lb-sandbox`, uid 10001 | same | |
| Filesystem | rootfs read-only, `/work` rw tmpfs 256 MiB, `/tmp` tmpfs 64 MiB | same | Writes outside `/work` fail or are unobserved, and the result's `limitations` says so. |
| Network | none (no interfaces except loopback) | same | Programs needing the network → `couldnt_run`/`not_runnable{network}`. |
| Resources | 1 vCPU, 512 MiB, pids 64, wall `timeout_ms`, output caps | same | Exceeded → `couldnt_run{reason}` |

### 7.4 Reference capture and provenance
`capture` job: for each case, run the original `repeat` times (default 2) in `env_orig`. If the observations are byte-identical → `reference_outputs(provenance='captured_original', source_revision_id, execution_env_id, capture_job_id, deterministic=true)`. Otherwise store the first observation with `deterministic=false` plus a per-channel `variance` summary. The job then creates a new case-set revision binding the new references. **User-supplied references** require `attestation` text and record `supplied_by`. They are displayed differently ("User-supplied reference") in results and in the export. Nothing produced by the replacement can be stored as a reference (invariant 6).

### 7.5 Comparison (`packages/compare`, pure, versioned semver)
Policy `rules` example:
```json
{ "engine": "1.0.0",
  "exit": { "mode": "exact" },
  "stdout": { "mode": "normalized", "normalizers": [ { "id": "line-endings", "version": 1 },
                                                    { "id": "trailing-whitespace", "version": 1 } ] },
  "stderr": { "mode": "ignore", "reason": "Diagnostic wording intentionally changed (scope c2)" },
  "files": { "include": ["out/**"], "mode": "exact" },
  "numeric": { "applies_to": "stdout", "tokenizer": "decimal-v1", "abs": 1e-9, "rel": 0 } }
```
- **Modes:** `exact` (byte equality), `normalized` (registered normalizers applied symmetrically, then byte equality), `tolerance` (tokenize both sides, compare non-numeric tokens exactly and numeric tokens within `abs`/`rel`; token counts must match), `ignore` (needs a `reason`, and ideally a scope intentional-change id; the result lists the channel as *not compared*).
- **Normalizers** are code in the engine, registered as `id@version` with a fixed behavior. `regex-replace@1` takes literal parameters that are recorded in the policy. A version bump never changes old behavior. Changing a policy creates a new `comparison_policies` revision, and therefore a new verification binding.
- **Cannot silently hide differences:** every result stores `raw_equal` and raw digests for both sides. `normalization_trace` = `[{channel, normalizer, changed_bytes_expected, changed_bytes_actual}]`. Outcome `match` with `normalized=true` is shown as "Match (after normalization: line-endings@1)". A channel set to `ignore` shows as "not compared" in the summary and in export `limitations`.
- **Structured differences:**
```json
[{ "channel": "stdout", "kind": "content", "first_difference": { "byte": 14, "line": 3, "column": 1 },
   "expected_excerpt": "c 1\n", "actual_excerpt": "d 1\n", "diff_blob": "sha256:…" },
 { "channel": "exit", "kind": "value", "expected": 0, "actual": 2 },
 { "channel": "files", "kind": "missing", "path": "out/report.csv" }]
```
- **Outcome decision:** no reference → `needs_reference`. Replacement observation incomplete (no build, sandbox error, timeout, limit, truncation) → `couldnt_run` + `diagnostics` (`{phase, reason, exit_of_harness, log_blob}`). Otherwise all compared channels are equal → `match`, else `difference`.

### 7.6 Replay outside the product
The export contains `harness/run-cases.mjs` (Node 22, no dependencies) plus the vendored `compare` engine at the same version. It builds the module (`npm ci && npx tsc`, with TypeScript pinned in `devDependencies`), runs each case through the same shim with the same env controls in a temp dir, and compares against `cases/*/reference/` using `policy/comparison-policy.json`. It writes `replay-report.json` and exits 0 only if the outcomes equal `results/verification-summary.json`. `--docker` runs inside `environment/Dockerfile.replacement` (pinned digest) for the closest reproduction. `--original /path/to/binary` (optional) recaptures references with `environment/Dockerfile.original`. The original binary is not included by default.

### 7.7 What "Match" establishes and what it does not
- **Establishes:** for *this* case input, in *this* environment (image digest + controls), the replacement's observed channels (exit, stdout, stderr, files under the observed paths) equaled the reference observation under *this* comparison policy revision. The reference came from the identified original source revision, or from a user with the recorded attestation.
- **Does not establish:** behavior on any other input; equivalence of unobserved effects (files outside `/work`, timing, memory, signals to other processes, network); correctness of the original or of the user-supplied reference with respect to business requirements; equivalence in other environments (other locales, clocks, glibc versions); absence of nondeterminism that did not show up in N captures; anything about channels set to `ignore`.

## 8. Security and operational requirements

### 8.1 Untrusted execution and parsing
- **Isolation tier:** gVisor (`runsc`) for *all* untrusted work. That covers running the original, running the replacement, building generated or customer code (`tsc` itself is trusted, but `package.json` scripts are not run: build uses `tsc` directly, never `npm run`), and analysis (Ghidra/REA parse attacker-controlled bytes). Worker hosts are dedicated to this purpose, with no other workloads and no cloud metadata endpoint reachable (blocked at the host firewall).
- **Sandbox spec:** non-root uid 10001, `no_new_privs`, default seccomp, all capabilities dropped, read-only rootfs, inputs read-only, single rw `/out` (size-capped), tmpfs `/work` and `/tmp`, `network=none`, cgroup v2 limits (CPU, memory, pids, IO), wall timeout enforced by the supervisor (SIGKILL of the sandbox), output-file size caps checked before upload.
- **Analysis sandbox limits:** 2 vCPU, 4–8 GiB (Ghidra `GHIDRA_HEADLESS_MAXMEM`, tuned in F1), 20 min.
- **Authority separation:** the sandbox launcher accepts a typed `SandboxSpec` built only from `execution_environments` rows and server constants. Artifact names are mapped to fixed internal paths (`/in/artifact-0`), so filenames are never interpolated into commands. Tool and model output is parsed as data (zod, max sizes, max counts). Strings from binaries are never interpreted as instructions to the orchestrator. Prompt injection through binary strings can at worst produce bad code. That code is confined by the output validator and the sandbox, and it is caught by verification.

### 8.2 Tenant isolation
Org-scoped repositories with mandatory `OrgContext`. Composite FKs. Per-org blob prefixes and per-org dedup. Presigned URLs are generated only for keys derived server-side from rows visible to the caller. Sandbox workdirs are per job (`/var/lib/lb/jobs/<job_id>`) and deleted afterwards. Each job runs in its own sandbox instance, never shared across orgs. RLS is added in S7. Cross-tenant test suite (§11).

### 8.3 Credentials
DB roles: `lb_api` (DML, no DDL), `lb_worker` (DML on job, run and result tables, plus read on inputs), `lb_purge`, `lb_migrate`. Storage: the API and workers use separate IAM users scoped to the bucket. The sandbox gets **no** credentials. The model API key exists only in the supervisor environment of generation-capable workers. Secrets come from env or the secret manager and are never written to job payloads or logs. The existing `.env` remains gitignored. Add `.env.example` documenting required variables.

### 8.4 Temporary artifacts and sensitive logs
Staging objects expire after 24 h (bucket lifecycle rule). Job workdirs are removed in `finally`, and the host reaper removes leftovers older than 2 h. Program stdout/stderr, pseudocode, strings and model transcripts are **customer data**: they are stored only as blobs and never written to application logs or metrics. App logs carry ids, sizes, digests and error codes only (pino with redaction paths). Error messages from tools are truncated to 2 KB and stored as diagnostics blobs, not as log lines.

### 8.5 Audit events (in `events`)
`member.added/removed/role_changed`, `org.setting_changed` (execution_enabled, external_model_allowed), `project.created/deleted/purged`, `upload.completed`, `source_revision.sealed`, `execution.consented`, `analysis.started/finished`, `scope_revision.created`, `scope.decided`, `generation.requested` (provider, model), `module_revision.created`, `reference.supplied` (attestation), `reference.captured`, `policy.created`, `verification.started/finished`, `export.created/downloaded`, `job.cancelled`. Each event carries actor, org, project, subject, request id and timestamp.

### 8.6 Observability
Structured JSON logs (`request_id`, `job_id`, `org_id`, `kind`, `attempt`). Metrics: queue depth per kind, job latency and outcome per kind, sandbox start failures, timeouts, OOM kills, lease expiries, Ghidra duration and memory, model tokens and cost per org. Health endpoints for the API and workers. Alerts: queue age > 10 min, lease-expiry rate, sandbox failure rate > 5%. OpenTelemetry tracing is optional (S7).

### 8.7 Storage limits and quotas (MVP defaults, per org, configurable)
Upload ≤ 200 MiB/file, ≤ 1 GiB/revision. Storage ≤ 20 GiB. ≤ 50 projects. ≤ 500 cases per case set. Case timeout ≤ 60 s. Output ≤ 8 MiB/channel. Concurrent jobs ≤ 4 (≤ 1 analysis). Generations ≤ 50/day. Exports ≤ 2 GiB. Quota checks happen at upload-session creation and job enqueue (`429 quota_exceeded` with `action`).

## 9. Export contract

### 9.1 Package structure
```
legacy-bridge-<project-slug>-<exportId8>/
  MANIFEST.json                 # see 9.2 (deterministic for a given binding; covered by SHA256SUMS)
  EXPORT_ID                     # export_id + created_at only; the single file NOT covered, so SHA256SUMS stays deterministic
  SHA256SUMS                    # integrity root: "<sha256>  <path>" for every file except itself and EXPORT_ID (includes MANIFEST.json)
  README.md                     # what this is, quick start, what Match means / doesn't (§7.7), limitations
  UNRESOLVED.md                 # human summary of unresolved.json
  module/
    package.json  package-lock.json  tsconfig.json
    src/**                      # editable source (module revision tree)
    bin/cli.mjs                 # shim
    examples/basic.mjs          # calling run() directly with deps
    INTERFACE.md                # public interface (.d.ts + JSON Schemas + error mapping)
  harness/
    run-cases.mjs  verify-integrity.mjs
    compare/                    # vendored packages/compare@<version>
  cases/<case-id>/
    input.json  stdin.bin  files/**
    reference/{observation.json, stdout.bin, stderr.bin, files/**}
    provenance.json             # captured_original{source_revision, env, job} | user_supplied{attestation, by}
  policy/comparison-policy.json
  results/verification-summary.json  results/cases/<case-id>.json
  environment/environment.json  Dockerfile.replacement  Dockerfile.original  DEPENDENCIES.md
  scope/scope-revision.json     # approved document: behaviors w/ basis, decisions, assumptions, questions
  evidence/findings.json        # cited findings with provenance (no binary unless included)
  unresolved.json
  original/ (only if include_original_binary=true) bin/<name>  lib/**
```

### 9.2 Manifest (abridged)
```json
{ "format": "legacy-bridge-export/1",
  "project": { "id": "prj_…", "name": "Wordfreq" },
  "binding": { "source_revision": { "id": "src_1", "manifest_sha256": "…", "primary": { "path": "bin/wordfreq", "sha256": "9f2c…" } },
               "scope_revision": { "id": "scp_3", "sha256": "…", "approved_by": "user_…", "approved_at": "…" },
               "module_revision": { "id": "mod_5", "tree_sha256": "…", "origin": "generated", "generator": { "provider": "codex", "model": "…" } },
               "build": { "id": "bld_…", "image": "sha256:…", "toolchain": { "node": "22.x", "typescript": "…" } },
               "case_set": { "id": "cs_4", "digest": "…" }, "policy": { "id": "pol_2", "digest": "…" },
               "environment": { "replacement": "sha256:…", "original": "sha256:…" },
               "verification_run": { "id": "vr_…", "binding_digest": "…", "completeness": "complete", "applies_to_current_at_export": true },
               "compare_engine": "1.0.0" },
  "summary": { "match": 7, "difference": 1, "couldnt_run": 0, "needs_reference": 2,
               "matched_cases": ["tc_1", "…"], "unresolved_cases": [{ "id": "tc_9", "outcome": "difference" }, { "id": "tc_3", "outcome": "needs_reference" }] },
  "unresolved": { "untranslated": 1, "open_questions": 1, "nondeterministic_references": 0, "ignored_channels": ["stderr"] },
  "limitations": ["Finite test set; no universal equivalence", "Filesystem observed only under working directory", "time_control: enforced"] }
```

### 9.3 Integrity and reproducibility
- **Integrity:** `SHA256SUMS` is the root. It covers every file, `MANIFEST.json` included, except itself and `EXPORT_ID`. `node harness/verify-integrity.mjs` recomputes every hash and fails on any mismatch, missing file or extra file, so editing `MANIFEST.json` (for example `summary.match`) is detected. The API and `export_packages` record `sums_sha256` (sha256 of `SHA256SUMS`) for out-of-band checking. Archive is a deterministic zip (sorted entries, fixed mtimes), so the same binding gives a byte-identical `SHA256SUMS`. Only `EXPORT_ID` differs. Signing `SHA256SUMS` (Sigstore/minisign) is a later addition.
- **Reproducibility limits:** replay outside `Dockerfile.replacement` may differ in Node version, locale or filesystem. Original references are recorded data: re-capturing needs the original binary, the pinned `Dockerfile.original`, and the same controls (faketime limits apply). References flagged nondeterministic are marked. The model generation itself is not reproducible, but its output (the source) is the artifact, and the generator metadata is recorded.

## 10. Implementation sequence

### 10.0 Proposed repository layout (new areas)
```
app/api/v1/**/route.ts        # Route Handlers (thin: auth → validate → server/domain)
server/  db/{schema.ts,migrations/}  domain/{projects,sources,analysis,scope,modules,cases,verification,exports}/
         jobs/{enqueue.ts,claim.ts,reaper.ts}  storage/s3.ts  auth/  http/{problem.ts,idempotency.ts,pagination.ts}
workers/ main.ts  analysis/{builtin-elf,rea}/  generation/{provider.ts,codex.ts,templates/}  build/  execution/{launcher.ts,harness/}  export/
packages/contracts/           # zod schemas shared by UI + API
packages/compare/             # pure comparison engine, vendored into exports
infra/ docker-compose.yml  images/{analysis,node-build,run-glibc,run-node22}/Dockerfile  runsc/
fixtures/ src/*.c  Makefile (builds in pinned gcc image; emits stripped + unstripped)  replacements/*/  cases/*/
tests/ unit/ integration/ e2e/
```
Tooling to add: `vitest`, `drizzle-orm` + `drizzle-kit`, `pg`, `zod`, `@aws-sdk/client-s3` + presigner, `next-auth`, `pino`, and the Codex CLI (S4). npm workspaces for `packages/*`.

### 10.1 Feasibility experiments (timeboxed, before S2+; F2 and F4 before S1 completes)
| # | Question | Exit criterion |
|---|---|---|
| F1 | REA (pinned) + Ghidra 12.1 headless inside the `lb-analysis` image under gVisor, on stripped and unstripped fixtures: which CLI commands list procedures, strings and xrefs? Time and memory? Are `ev_` ids stable across reruns? | Procedure, string, xref and decompile JSON for 3 fixtures in < 5 min each at ≤ 8 GiB. Each item recorded as *works*, *needs MCP-over-stdio fallback*, or *unsupported*. |
| F2 | gVisor run of an ELF fixture with the harness: does `network=none` hold, does libfaketime take effect, is `setarch -R` honored, are outputs identical over 20 runs, what is the sandbox start latency? | Deterministic fixture identical 20/20. Faketime works for dynamic binaries. Start latency < 1 s (else pool or batch cases per sandbox). |
| F3 | Can generation from scope + pseudocode for `wordfreq`/`intcalc` produce TS that builds and matches? | Builds in ≤ 2 attempts. ≥ 80% of `wordfreq` cases match. Untranslated list is non-empty for `intcalc` overflow. |
| F4 | MinIO and S3 presigned PUT with `x-amz-checksum-sha256` enforced | A wrong checksum is rejected by storage. Otherwise the inspect job's recomputed hash is the only gate (still required). |
| F5 | REA `capture-process` vs. our pipe harness for batch CLIs | Confirm the decision in §6.2 (expected: own harness; REA capture deferred). |

### 10.2 Slices
**S1 — Walking skeleton: one fixture, import → export (no Ghidra, no LLM)**
- *Unlocks:* a user (dev auth) creates a project, uploads `wordfreq` + `stopwords.txt`, sees format/arch/deps and separate analysis and execution eligibility, approves a hand-written scope (raw JSON accepted), uploads a TS replacement tarball, sees build status, defines 10 cases, captures references, runs verification, and downloads an export.
- *Areas:* `server/db` (all §3 tables needed by this path), `server/jobs`, `server/storage`, `app/api/v1` (projects, uploads, source-revisions, consent, probe, scope-draft/revisions/decision, module-revisions upload, test-cases, reference-captures, case-set-revisions, comparison-policies with default exact policy, verification-runs, exports, jobs, activity), `workers/{analysis/builtin-elf,build,execution,export}`, `packages/{contracts,compare}`, `infra/` (compose + runsc + 3 images), `fixtures/wordfreq`, minimal UI wiring in `components/Workflow.tsx`/`App.tsx` behind a feature flag.
- *Depends on:* F2, F4.
- *Acceptance:* (1) The `e2e/import-to-export.test.ts` script drives the API end-to-end against compose and passes. (2) Source revision shows `analysis: eligible`, `execution: runnable` after the probe. (3) 10/10 cases have `captured_original` references with `deterministic=true`. (4) Verification summary is `match:10`. (5) Export `verify-integrity.mjs` passes, and `run-cases.mjs` in a clean `node:22` container with `--network none` reproduces `match:10`. (6) Re-POSTing the same verification returns `reused:true`. (7) Uploading a second module revision makes the earlier run `applies_to_current:false` with `module_revision_changed`.
- *Tests:* unit tests for the ELF parser (header, `PT_INTERP`, `DT_NEEDED`) against fixtures. Compare-engine golden tests. Job claim/lease/finalize unit tests with two concurrent claimers. Integration tests for immutability triggers (UPDATE rejected). Org-scope test (second org gets 404 on every S1 route). The e2e test above.
- *Main uncertainty:* gVisor and harness determinism, sandbox start cost (F2).

**S2 — Evidence index with REA + Ghidra**
- *Unlocks:* function, string, xref and import findings browsable with provenance. Candidate workflows. Deep-function pseudocode. Scope behaviors cite findings, with server-side validation.
- *Areas:* `workers/analysis/rea`, `images/analysis`, `server/domain/analysis`, findings and candidates endpoints, `fixtures` stripped variants.
- *Depends on:* F1, S1.
- *Acceptance:* the index run on stripped `wordfreq` records versions and image digest. ≥ 90% of functions from the unstripped symbol table are discovered by address in the stripped build (or the gap is reported as coverage). Every finding's `artifact_sha256` matches. `provider_evidence_id` resolves in the stored raw bundle. A PE fixture yields `outcome: unsupported` with reason. A Ghidra timeout yields `partial` with limitations.
- *Tests:* adapter contract tests on recorded REA JSON (golden), plus a live test (nightly) on the pinned image. Provenance resolution test. Pagination stability test.
- *Main uncertainty:* REA CLI coverage for list operations and its stability across versions.

**S3 — Scope editing, approvals, concurrency**
- *Unlocks:* draft editing with optimistic locking, revisions, approve/reject, decisions/assumptions/open questions, dependencies made explicit inputs with responsibility notes.
- *Areas:* `server/domain/scope`, scope endpoints, `packages/contracts/scope.v1.ts`, UI Select stage wiring.
- *Depends on:* S2 (evidence ids).
- *Acceptance:* concurrent `PUT` with a stale `If-Match` → 412. Two simultaneous approvals → exactly one 200, the other 409. Module creation against an unapproved revision → 409. Re-approval moves the head and marks prior verification runs stale (`scope_reapproved`).
- *Tests:* race tests (parallel requests), schema validation tests, evidence-reference validation tests.
- *Main uncertainty:* how expressive the scope document must be for real users (keep schema_version-able).

**S4 — Generation and source edits**
- *Unlocks:* generate a TS module from the approved scope + evidence, see build diagnostics and untranslated behavior, edit files (each edit = a new revision), regenerate or repair.
- *Areas:* `workers/generation`, `workers/build` (marker cross-check), module endpoints (generated/edit), org setting `external_model_allowed`.
- *Depends on:* S3, F3.
- *Acceptance:* generation records provider, model, template, input and output digests and the transcript blob. Output with `../` paths or non-`node:` imports is rejected. `intcalc` generation lists untranslated overflow behavior or produces a verified match. An edit creates revision N+1 and a build automatically.
- *Tests:* generator adapter tests with a fake provider (deterministic fixtures). Output-validator tests (traversal, symlink, size, imports). Build diagnostics parsing. Live model test (manual or nightly, not CI-gating).
- *Main uncertainty:* generation quality and cost on stripped code.

**S5 — Verification depth**
- *Unlocks:* normalized and tolerance policies, ignored channels with reasons, user-supplied references, nondeterminism detection, stateful step sequences, file-effect comparison, cancellation with partial results, diff views.
- *Areas:* `packages/compare` (normalizers, tolerance, files), capture repeat logic, results endpoints, cancel flow.
- *Depends on:* S1 (can run in parallel with S2–S4).
- *Acceptance:* `intcalc` naive replacement → `difference` with byte, line and column location. The same with a tolerance policy → `match (normalized/tolerance)`, with `raw_equal=false` and a trace. `rand` fixture reference flagged `deterministic=false` → never `match` without an explicit rule. Cancel midway → `completeness=partial`, completed results kept, no duplicates.
- *Tests:* property-based tests (fast-check) for the compare engine. Cancellation and crash integration tests.
- *Main uncertainty:* normalizer design that users understand without hiding real differences.

**S6 — Export hardening and replay**
- *Unlocks:* complete package (§9), Dockerfiles, unresolved report, integrity verifier, optional original binary.
- *Areas:* `workers/export`, `harness/` templates.
- *Depends on:* S5.
- *Acceptance:* CI job unzips each fixture export in clean containers and the replay outcomes equal the stored summary. A one-byte tamper fails integrity. The same binding produces an identical `SHA256SUMS`.
- *Tests:* replay CI lane, tamper test, deterministic-zip test.
- *Main uncertainty:* replay fidelity outside Docker (documented limits).

**S7 — Multi-tenant hardening and operations**
- *Unlocks:* OIDC login, org membership management, RLS, quotas, audit views, retention and purge jobs, metrics and alerts.
- *Areas:* `server/auth`, migrations (RLS policies), `server/jobs/purge`, observability.
- *Depends on:* S1 (can start after S1 in parallel).
- *Acceptance:* the cross-tenant suite passes with RLS enabled and repository scoping bypassed (defense-in-depth test). Purge removes rows and unreferenced blobs after the grace period. Quota breaches return 429 with an action.
- *Tests:* route-manifest-driven cross-tenant tests, purge tests, quota tests.
- *Main uncertainty:* IdP choice and customer SSO needs (out of MVP).

## 11. Validation strategy

### 11.1 Fixtures (C sources in `fixtures/src`, built reproducibly in a pinned `gcc` image; stripped and unstripped variants)
| Fixture | Behavior | Validates |
|---|---|---|
| `wordfreq` | stdin text → top-N word counts, `--top N`, reads `stopwords.txt` | Matching output, full import-to-export path, required-state file |
| `intcalc` | 32-bit wrapping arithmetic, `printf("%.2f")` rounding, exit 2 on bad args | Intentional difference / naive replacement difference, tolerance policy, untranslated flagging, nonzero exit as observation |
| `wordfreq` with execution disabled (org setting off) + user-supplied refs for 3 of 6 cases | — | `needs_reference` for 3, `user_supplied` provenance display, export unresolved list |
| `hello.exe` (PE32), `hello-macho`, `hello-aarch64` (ELF), `run.sh` | — | `unsupported` analysis/execution with reasons, never executed |
| `needslib` (DT_NEEDED `libfoo.so.1` not supplied), `segv` (null deref), `spin` (infinite loop), `bigout` (100 MiB stdout) | — | `not_runnable{missing_library}` before running; segfault = observation (signal 11); timeout and output cap → `couldnt_run` |
| `kvstore` | `set k v` / `get k` against `db.txt` in cwd, multi-step case | Stateful step sequences, file-effect comparison (created/modified) |
| `clock`, `rand` | prints `time()` / `rand()` seeded by pid | faketime control works (clock deterministic); `rand` flagged `deterministic=false` |
| `wordfreq` replacements v1 (correct) → v2 (introduces a bug) | — | Revision change: v1 run becomes stale, v2 run shows difference; old results unchanged |

### 11.2 How each property is validated
- **Analysis provenance:** for every finding in fixture runs, assert `artifact_sha256 ∈ revision artifacts`, `provider_evidence_id` exists in the stored raw bundle, and (for functions) the address appears in the unstripped build's `nm` symbol table. Discovery recall on stripped builds is reported as a metric with a floor (≥ 90%).
- **Comparison correctness:** golden tests per channel and mode. Property tests: `compare(x,x)=match`. Any single-byte mutation in a compared channel → `difference`, unless covered by a declared normalizer, in which case the trace shows the change. Normalizers are symmetric (`compare(a,b)` outcome = `compare(b,a)`). `ignore` channels are listed as not compared. The engine version bump test ensures old policies produce identical results.
- **Job recovery:** integration tests that SIGKILL a worker mid-verify → lease expires → another worker resumes. Assert no duplicate `verification_results`, a single finalize, and an `attempt` increment. Force the same job onto two workers → exactly one finalize, with the other's writes as no-ops. Cancellation → partial run with preserved results. Orphan sandbox killed by the host reaper.
- **Revision and staleness:** the API contract tests in §10 S1/S3/S5 (module change, re-approval, case-set change, policy change each produce the correct `stale_reasons`). Direct SQL `UPDATE` on immutable tables fails.
- **Cross-tenant access:** a test generator walks the route manifest. For every route, org B's user requests org A's resource ids (projects, revisions, findings, blobs by sha256, jobs, exports) → 404. Presign endpoints never return URLs for org A keys. Repeated with RLS on and the repository scope bypassed (S7).
- **Exported replay:** CI unzips each fixture export into a fresh `node:22` container with `--network none` and no repo checkout, runs `verify-integrity.mjs` and `run-cases.mjs`, and asserts the outcomes equal `results/verification-summary.json`. A tamper test is included.

## 12. Decisions and open questions

### 12.1 Major decisions
| Decision | Recommendation | Tradeoff |
|---|---|---|
| Service shape | Modular monolith (Next.js API) + one worker program with job kinds | Fewer deploy units. The domain layer must stay framework-independent (`server/`) so the API can move out of Next.js later. |
| Queue | Postgres `jobs` table with `SKIP LOCKED` + leases | No Redis. Job and domain state commit in one transaction. Throughput is limited (fine for MVP). graphile-worker is an acceptable alternative. |
| Isolation | gVisor for all untrusted work, on dedicated Linux workers | Rules out serverless workers. Some syscall incompatibility risk (F2). Firecracker is stronger but heavier. |
| Analysis | REA CLI + Ghidra, pinned, behind `AnalysisProvider`, plus a tiny built-in ELF parser | Reuses deep RE capability. REA changes quickly, so it needs pinned versions and contract tests. Commercial providers are excluded from the hosted service. |
| Execution harness | Own pipe-based harness and comparison engine. REA process capture not used in MVP | Byte-exact separate streams and replay outside the product. We maintain the harness. |
| Target | TypeScript/Node 22, no runtime deps | Matches the stack and UI. C numeric semantics need care. |
| Progress delivery | Polling with ETag; SSE later | Slightly more requests. Simplest and robust behind proxies. |
| Revisions | Immutable rows + mutable head pointers via CAS | More rows. Gives exact lineage and safe concurrency. |
| Generation | Structured requests built from persisted state; Codex CLI behind `CodeGenerator` | The database stores the generation inputs and outputs. Requires org consent. |

### 12.2 Facts (verified in this session)
- The repo is a client-only Next.js 16 / React 19 / TS 7 prototype. Import keeps only the filename. Context accepts image/video only. Verify and Export are mocked. There is no backend, DB, tests, CI, infra or AGENTS.md.
- REA (MIT, TypeScript, npm `rea-agents`, Node 22.23.4+/24.22.1+/26.12.1+) offers a CLI with `--json` and MCP. Native analysis via Ghidra 12.1+ headless with a full JDK on Linux x64/arm64. Operations include `inspect/analyze/search/function/decompile/instructions/xrefs/trace/procedure-references` and MCP `list_procedures/list_strings/search_strings/list_names`. It has `--snapshot` caching and Evidence records with ids, provider, authority, limitations, unknowns and coverage.
- REA process capture is PTY-based, records filesystem snapshots, and is documented as "not a sandbox". The REA README says REA grants no license for commercial tools (Hopper, IDA, JEB), and that vendor terms, including for trials and demos, may restrict automation and output sharing.

### 12.3 Assumptions
- Initial customers have Linux x86-64 CLI tools (not Windows). TypeScript is an acceptable target.
- We can operate Linux hosts with gVisor. S3-compatible storage and managed Postgres are available.
- Customers are authorized to analyze and run what they upload (consent captured per revision). Sending pseudocode to a model API is acceptable for orgs that opt in.
- Batch process-boundary verification is valuable without in-process function harnessing.

### 12.4 Unresolved feasibility questions (answered by spikes)
F1 REA CLI coverage, Ghidra cost and Evidence-id stability under gVisor. F2 gVisor determinism, faketime, ASLR and start latency. F3 generation quality on stripped code. F4 checksum-enforced presigned uploads on MinIO/S3. F5 confirming the own-harness decision. Also unresolved: discovery recall on optimized/stripped binaries, and glibc compatibility for old binaries (may need multiple `run-glibc` images by era).

### 12.5 Questions that would materially change implementation
1. **Deployment:** can we run dedicated Linux worker hosts with gVisor (or customer-hosted workers), or must everything run on a managed/serverless platform? This decides the isolation design.
2. **First customer workload:** are the first legacy executables really Linux ELF CLIs, or Windows PE / interactive or TTY programs? The latter would replace the MVP family (Wine or Windows sandboxes, REA PTY capture).
3. **Model data policy:** may decompiled code and strings be sent to an external model API, or is self-hosted / no-LLM generation required for target customers?
4. **Target language:** is TypeScript/Node right for the buyers' modern stack, or should the first target be Java, C#, Python or Go?
5. **Retention and redistribution:** may we keep uploaded binaries for the project lifetime and include them in exports, and what deletion or residency obligations apply?
