# Legacy Bridge

Turns functionality from legacy executables into reusable TypeScript, with rerunnable tests that check the new code preserves the original behavior.
Workflow: **Import → Select → Modernize → Verify → Export**.

Two things live in this repo:
- **UI** (`app/`, `components/`, `lib/`): Next.js 16 App Router and React 19. The default prototype stores projects and attachments in the browser. `NEXT_PUBLIC_LB_S1_UI=1` enables the local backend workflow on the same five routes. Setup is in the README.
- **Backend** (`app/api/v1`, `server/`, `workers/`, `packages/`, `infra/`, `fixtures/`, `tests/`): built to `docs/backend-plan.md`, which starts with an implementation-status table. Read that table before assuming anything exists. MVP target: Linux x86-64 ELF command-line programs → TypeScript on Node 22.

## Commands

```
npm test                 # vitest: unit + API + e2e. e2e needs Docker + `make -C fixtures`; it skips with a reason otherwise
npm run typecheck        # tsc --noEmit (TypeScript 7)
npm run build            # next build; also type-checks the route handlers
npm run fixtures         # builds x86-64 ELF fixtures in a pinned gcc image (works on Apple Silicon via emulation)
npm run migrate          # needs DATABASE_URL
npm run worker           # needs DATABASE_URL, S3_BUCKET, LB_SANDBOX=direct (see isolation below)
TEST_DATABASE_URL=postgres://lb:lb@localhost:5432/postgres npm test          # same suite on real Postgres (each `testDb()` call creates a fresh database)
S3_TEST_ENDPOINT=http://localhost:9090 npx vitest run tests/integration      # S3 store against an S3-compatible server
```

Run the whole suite and `typecheck` before saying something works. Tests default to PGlite (Postgres in WASM, single connection), so concurrency claims need the `TEST_DATABASE_URL` run.
Docker's CLI is at `~/.docker/bin/docker`, which may not be on `PATH`; tests look there and honor `DOCKER_BIN`.

## Layout

```
app/api/v1/**/route.ts   generated, 3-line files that re-export handlers from server/api/handlers.ts
server/domain/           business rules and invariants; framework-independent (no Next imports)
server/http/handler.ts   route(): auth → role → validate → idempotency → problem+json errors
server/db/               SQL migrations (source of truth), Db interface, pg + PGlite drivers, uuidv7
server/jobs/queue.ts     Postgres job queue: SKIP LOCKED claim, leases, reaper
server/storage/          BlobStore interface; FsBlobStore (tests), S3BlobStore (prod)
workers/main.ts          job loop + handlers (inspect, native analysis, probe, build, capture, verify, export)
workers/execution/       harness.ts (case runner), runners.ts (Docker runners, hardeningArgs)
workers/analysis/builtin-elf/   ELF parser + eligibility
workers/analysis/rea/    bounded REA/Ghidra Docker runner and evidence normalization
workers/export/          export builder, deterministic zip, replay templates
packages/contracts/      zod schemas shared by UI and API
packages/compare/        pure comparison engine; bundled into every export
tests/{unit,api,e2e,integration,helpers}
```

## Invariants to keep (plan §4.4)

- Immutable tables (revisions, test cases, references, results, policies) reject UPDATE/DELETE via triggers. Do not "fix" data by updating them; create a new revision.
- A reference is only ever `captured_original` or `user_supplied`. Nothing derived from the replacement may be stored as a reference. No reference ⇒ `needs_reference`, never `match`.
- Nonzero exit, signal, or exception from either program **is an observation** and is compared. `couldnt_run` means no complete observation exists (build failed, timeout, output cap, harness error).
- Every verification run binds exact ids **and content digests** (`bindingDigest`). `applies_to_current` is computed on read and never stored.
- All rows are org-scoped. Cross-org access returns **404, never 403**. Blob keys are derived server-side from `(org, sha256)`; never accept a key from a client.
- Execution requires both `organizations.execution_enabled` and per-revision consent.
- Generation sends scope and evidence to an external model, so it needs `organizations.external_model_allowed` (checked at request and again in the worker) and runs only from the approved scope head. `origin: 'generated'` revisions are created by the worker alone; model output is validated (paths, `node:`-only imports, limits) before anything is stored. Decompiled evidence is untrusted data in the prompt.
- Customer/generated code is untrusted. A module may `import 'node:*'`, so **the container is the boundary, not the import filter**.
- `judge()` in `packages/compare` is the single place that turns a run into an outcome. The verify worker and the exported replay both use it; do not duplicate that logic.
- Program output, strings and artifact content are customer data: never put them in logs or job errors. (Set `LB_DEBUG_ERRORS=1` locally to see error messages.)

## Isolation (read before touching runners or the worker image)

- Original binaries and replacement modules run through `DockerOriginalRunner` / `DockerReplacementRunner` using `hardeningArgs` (no network, read-only rootfs, non-root uid 10001, caps dropped, limits). Images must be pinned by digest.
- Local Docker is **runc, not gVisor**. `runtime: 'runsc'` is an option for Linux worker hosts; it is untested.
- `tsc` builds still run on the host (`localBuild`). The worker refuses to start unless `LB_SANDBOX=direct`, and refuses that when `NODE_ENV=production`. The worker Dockerfile sets production on purpose. Do not bake `LB_SANDBOX=direct` into an image.
- `LocalReplacementRunner` (unisolated) exists for tests only; do not wire it into `workers/run.ts`.

## Gotchas learned the hard way

- **Postgres param types:** reusing a parameter as both `uuid` and `text` fails ("inconsistent types deduced"). Use `$2::uuid::text`, not `$2::text`.
- **`ORDER BY id` with `SELECT id::text AS id`** sorts as text (`evt_10` before `evt_2`). Qualify it: `ORDER BY events.id`.
- Check `Response` status 204/304: they cannot carry a body (`new Response(null, …)`).
- Next 16 route params arrive as a `Promise`; the `route()` wrapper awaits them. Catch-all params are `string[]`.
- macOS `sed -i` needs a backup-suffix argument and mangles `$` in patterns. Use the Edit tool or python for file edits.
- Node ≥ 22.2 is required (`zlib.crc32` in the zip writer). `esbuild` is a runtime dependency (the export bundles the harness).
- MinIO's public images were not pullable (2026-11-14); `infra/docker-compose.yml` uses `adobe/s3mock` for dev.
- Dev auth is headers (`X-Org-Id`, `X-User-Id`) behind `LB_DEV_AUTH=1` and refused in production. Real login is slice S7.

## Conventions

- TypeScript strict. Server code stays free of Next/React imports so the API can move out of Next later.
- Migrations: append a new `server/db/migrations/000N_*.sql`; never edit an applied one. Drizzle is **not** used.
- Add a route by adding the handler to `server/api/handlers.ts` and a 3-line `route.ts` under `app/api/v1` (copy an existing one, keep `runtime = 'nodejs'`). Extend the cross-tenant sweep in `tests/api/api.test.ts` (`BODY`/`PARAM` maps) so the new route is covered.
- Every endpoint that creates a resource or job is `idempotent: true` and needs an `Idempotency-Key` header.
- When behavior is only verified on a substitute (PGlite, S3Mock, runc), say so in the test header comment and in reports.

## Repo etiquette

- Do not commit unless asked. `index.html` shows as deleted in `git status` and that is the owner's change; leave it alone.
- Do not read `.env` (it is gitignored and its contents are private). `.env.example` documents the variables.
- `graphify-out/` holds a generated knowledge graph; `graphify-out/GRAPH_REPORT.md` summarizes it. Query it with `/graphify query "…"` before grepping broadly. It is not currently gitignored; machine-specific files inside it (`.graphify_python`, `.graphify_root`, `cache/`, `cost.json`) should not be committed.
