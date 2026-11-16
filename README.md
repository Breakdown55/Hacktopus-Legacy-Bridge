# Legacy Bridge

Legacy Bridge turns functionality from legacy executables into reusable, modern code, and proves the new code behaves like the original.

You upload a compiled program. You pick the behavior you want to keep. Legacy Bridge produces a replacement module and a set of rerunnable tests. Those tests compare the replacement's output against results captured from the real original program. You export the module with the tests and run them anywhere.

## The problem

Many organizations depend on old compiled programs whose source is lost, undocumented or unmaintainable. Rewriting them by hand is risky because nobody can say whether the rewrite behaves the same. Legacy Bridge makes the rewrite evidence-based: every claim of equivalence is backed by a recorded run of the original.

## Workflow

**Import → Select → Modernize → Verify → Export**

| Stage | What happens |
| --- | --- |
| **Import** | Upload the executable and optional context (notes, sample inputs, screenshots). Each upload becomes an immutable, hashed source revision. |
| **Select** | Static analysis (a built-in ELF parser plus REA and Ghidra) produces evidence: functions, strings, imports, pseudocode. You cite that evidence in a scope document that describes the behaviors to keep, then review and approve it. |
| **Modernize** | An AI model (Codex CLI) generates a replacement module from the approved scope and cited evidence. The module is built in a sandbox and each version is stored as a numbered revision. You can also upload a module you wrote yourself. |
| **Verify** | Test inputs are run through the original in a sandbox to capture reference results, then through the replacement. A comparison engine reports `match`, `difference`, `needs_reference` or `couldnt_run` for each case. |
| **Export** | A deterministic ZIP with the module, test cases, checksums, an integrity verifier and a replay harness. It runs offline with Node, or in Docker. |

### Supported targets

The MVP target is non-interactive **Linux x86-64 ELF command-line programs** (arguments, stdin and input files in; stdout, stderr, exit status and output files out). Replacement modules can be generated in:

| Language | Runtime |
| --- | --- |
| TypeScript | Node.js 22 |
| Python | 3.12 |
| Go | 1.24 |
| Java | 21 |
| C# | .NET 8 |

PE and Mach-O files are accepted on Import in the browser prototype, but analysis of them is not supported yet.

## Design principles

- **Evidence over assertion.** A reference result is only ever captured from the original program or supplied by the user. Nothing derived from the replacement is stored as a reference. With no reference, a case is `needs_reference`, never `match`.
- **Nonzero exits count.** A crash, signal or nonzero exit from either program is an observation and gets compared. `couldnt_run` means no complete observation exists.
- **Immutable history.** Revisions, test cases, references, policies and results cannot be updated or deleted. Changes create a new revision. Every verification run records content digests of what it tested, and whether it still applies to the current revisions is computed when read.
- **Untrusted code stays in a container.** Original binaries and replacement modules run in Docker with no network, a read-only filesystem, a non-root user, dropped capabilities and resource limits. The container is the security boundary, not an import filter.
- **Consent for outside services.** Execution needs per-organization and per-revision consent. Generation sends scope and evidence to an external model, so it needs its own per-organization setting.
- **Tenant isolation.** All rows are scoped to an organization, enforced with Postgres row-level security. Cross-organization access returns 404.

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | Next.js 16 (App Router), React 19, TypeScript 7 |
| API | Next.js route handlers under `app/api/v1`, with framework-independent business logic in `server/` |
| Validation | Zod schemas in `packages/contracts`, shared by the UI and API |
| Database | PostgreSQL, with plain SQL migrations (PGlite in tests) |
| Job queue | Postgres (`SKIP LOCKED` claims, leases, a reaper) |
| Object storage | S3-compatible (AWS S3 in production, S3Mock locally, the filesystem in tests) |
| Auth | Auth.js with one OIDC provider and encrypted session cookies; header-based dev auth for local use |
| Workers | A Node process (`workers/`) that handles inspect, analysis, probe, build, capture, verify, export and purge jobs |
| Static analysis | Built-in ELF parser; REA 6.9.0 and Ghidra 12.1 in a pinned Docker image |
| Code generation | Codex CLI behind a `CodeGenerator` interface, running locally or on a separate machine |
| Sandboxing | Docker, with a gVisor (`runsc`) option for Linux hosts |
| Export | esbuild bundles the harness; a deterministic zip writer with `SHA256SUMS` |
| Tests | Vitest and fast-check; Docker-based end-to-end tests with fixture binaries |

## Repository layout

```
app/                 Next.js pages and API routes (app/api/v1)
components/, lib/    UI components and client-side helpers
server/              domain rules, HTTP handler, DB drivers and migrations, job queue, blob storage
workers/             job loop, analysis, build, execution harness, export
packages/contracts/  shared zod schemas
packages/compare/    comparison engine, also bundled into every export
fixtures/            sample ELF programs and replacements (wordfreq, intcalc, ...)
infra/               docker-compose, worker/web/analysis images
tests/               unit, api, e2e, integration
docs/                backend plan, setup guides, spike reports
```

## Quick start (UI prototype)

Requires Node 22.2 or later.

```
npm ci
npm run dev
```

Open http://localhost:3000. In this default mode, projects and attachments are stored in the browser. Modernize, Verify and Export only preview the workflow.

## Running the full workflow locally

This uses the real backend: Postgres, S3, a worker and Docker. It needs Docker, a Postgres database and an S3-compatible bucket. A full walkthrough is in the [setup guide](docs/setup-and-slices.md).

1. Start the services: `docker compose -f infra/docker-compose.yml up -d postgres s3`
2. Copy `.env.example` to `.env`, fill it in, set `NEXT_PUBLIC_LB_S1_UI=1`, then run `npm run migrate` and `npm run s1:seed`.
3. Build the sample fixtures: `npm run fixtures`
4. Start the worker: `LB_SANDBOX=direct npm run worker`
5. Start the app: `npm run dev -- --hostname 127.0.0.1 --port 3100`

For a first run, create a project, upload `fixtures/bin/wordfreq`, and follow the five stages. Generation needs the Codex CLI signed in (`LB_GENERATION_PROVIDER=codex`) and `external_model_allowed` enabled for your organization.

## Commands

```
npm test             # unit, API and e2e tests (e2e needs Docker and `npm run fixtures`, and skips otherwise)
npm run typecheck    # tsc --noEmit
npm run build        # next build
npm run migrate      # apply SQL migrations (needs DATABASE_URL)
npm run worker       # job worker
npm run worker:codex # remote generation worker (separate machine)
npm run fixtures     # build the sample ELF fixtures in a pinned gcc image
```

Tests default to PGlite. To run them on real Postgres, use `TEST_DATABASE_URL=postgres://lb:lb@localhost:5432/postgres npm test`.

## Status and known limits

This is a working prototype and not production software.

- Sandboxing uses plain Docker (runc), not gVisor. TypeScript builds run on the host, so the worker refuses to start in production mode unless that is addressed.
- There is no login UI yet. Local use relies on dev auth headers, and the browser flow is meant for loopback only.
- Only Linux x86-64 ELF programs can be analyzed. Nondeterministic programs and interactive programs are out of scope.
- Production deployment (AWS, RDS, gVisor) is designed but has not been run.

For the full implementation status, see the [backend plan](docs/backend-plan.md).

## More documentation

- [Setup guide and slice notes](docs/setup-and-slices.md): detailed local setup, scope approvals, code generation and the two-laptop demo
- [Backend plan](docs/backend-plan.md): design and an implementation-status table
- [Codex handoff](docs/README-codex-handoff.md), [Windows test handoff](docs/README-windows-test-handoff.md), [Vercel demo](docs/README-vercel-demo.md)
- [F1 analysis spike](docs/f1-analysis-spike.md) and [F3 results](docs/README-windows-f3-results.md)
