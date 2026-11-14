# Graph Report - Hacktopus-Legacy-Bridge  (2026-11-14)

## Corpus Check
- Corpus is ~37,612 words - fits in a single context window. You may not need a graph.

## Summary
- 729 nodes · 1772 edges · 54 communities (52 shown, 2 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 39 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- API Handlers & Route Helpers
- Worker Handlers & Blob Storage
- Job Queue & Case Domain
- Prototype UI (Next.js)
- Compare Engine
- App Wiring & Test Tooling
- Docker Compose Infra
- Status Contracts
- Tar & Export Zip
- tsconfig Settings
- Dev Dependencies
- Runtime Dependencies
- UI Screenshot Concepts
- Docs: Plan, gVisor, Known Gaps
- package.json Metadata
- wordfreq C Fixture
- npm Scripts
- wordfreq TS Replacement
- compare package.json
- contracts package.json
- Root Layout
- API Route [jid]
- API Route [pid]
- API Route scope-draft
- API Route projects
- API Route download
- API Route [eid]
- API Route cancel
- API Route builds
- API Route [...path]
- API Route [mid]
- API Route activity
- API Route [sha]
- API Route case-set-revisions
- API Route comparison-policies
- API Route exports
- API Route module-revisions
- API Route reference-captures
- API Route scope-revisions
- API Route source-revisions
- API Route test-cases
- API Route uploads
- API Route verification-runs
- API Route decision
- API Route execution-consent
- API Route probe
- API Route [sid]
- API Route reference-outputs
- API Route complete
- API Route results
- API Route [vrid]
- Next Config
- Repository Metadata
- React Types

## God Nodes (most connected - your core abstractions)
1. `DomainError` - 41 edges
2. `uuidv7()` - 40 edges
3. `api` - 32 edges
4. `getHeads()` - 30 edges
5. `Db` - 26 edges
6. `digest()` - 22 edges
7. `BlobStore` - 21 edges
8. `assertSafe()` - 17 edges
9. `App()` - 16 edges
10. `vitest` - 16 edges

## Surprising Connections (you probably didn't know these)
- `call()` --calls--> `uuidv7()`  [EXTRACTED]
  tests/api/api.test.ts → server/db/ids.ts
- `Page()` --calls--> `App()`  [EXTRACTED]
  app/page.tsx → components/App.tsx
- `RunOutcome` --references--> `ObservationData`  [EXTRACTED]
  workers/execution/harness.ts → packages/compare/src/engine.ts
- `verifyHandler()` --calls--> `judge()`  [EXTRACTED]
  workers/handlers/verify.ts → packages/compare/src/judge.ts
- `WorkerEnv` --references--> `Db`  [EXTRACTED]
  workers/runtime.ts → server/db/db.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Project cards on the Your Projects screen** — screenshot_2026_11_14_105744_banking_tools, screenshot_2026_11_14_105744_billing_portal, screenshot_2026_11_14_105744_inventory_app [EXTRACTED 1.00]

## Communities (54 total, 2 thin omitted)

### Community 0 - "API Handlers & Route Helpers"
Cohesion: 0.07
Nodes (86): RFC-9562, P, pid(), projectOf(), sha, text, uuid, uuidv7() (+78 more)

### Community 1 - "Worker Handlers & Blob Storage"
Cohesion: 0.06
Nodes (29): ensureEnvironment(), assertSafe(), blobKey(), BlobStore, PresignedPut, stagingKey(), FsBlobStore, S3BlobStore (+21 more)

### Community 2 - "Job Queue & Case Domain"
Cohesion: 0.09
Nodes (46): CaseInput, CaseSetEntry, finalizeRun(), recordResult(), cancel(), claim(), EnqueueInput, finish() (+38 more)

### Community 3 - "Prototype UI (Next.js)"
Cohesion: 0.10
Nodes (41): Page(), App(), addFeature(), advance(), commit(), notify(), openProject(), submitDialog() (+33 more)

### Community 4 - "Compare Engine"
Cohesion: 0.08
Nodes (38): RFC-9457, compare(), COMPARE_ENGINE_VERSION, compareBytes(), CompareResult, countChanged(), empty(), excerpt() (+30 more)

### Community 5 - "App Wiring & Test Tooling"
Cohesion: 0.10
Nodes (23): pg, vitest, App, getApp(), setApp(), Db, db, dir (+15 more)

### Community 6 - "Docker Compose Infra"
Cohesion: 0.07
Nodes (28): context, dockerfile, COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS, POSTGRES_DB, POSTGRES_PASSWORD, POSTGRES_USER, environment, image (+20 more)

### Community 7 - "Status Contracts"
Cohesion: 0.10
Nodes (23): AnalysisEligibility, ArtifactRole, ExecutionEligibility, JobKind, JobStatus, Role, buildElf(), bin() (+15 more)

### Community 8 - "Tar & Export Zip"
Cohesion: 0.14
Nodes (14): oct(), packTar(), pad(), unpackTar(), ok(), buildExport(), BuiltExport, bundleHarness() (+6 more)

### Community 9 - "tsconfig Settings"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 10 - "Dev Dependencies"
Cohesion: 0.12
Nodes (16): devDependencies, @electric-sql/pglite@^0.5.16, fast-check@^4.10.2, tsx@^4.23.15, @types/node@^26.6.6, @types/pg@^8.23.1, @types/react-dom@^19.3.0, typescript@^7.0.2 (+8 more)

### Community 11 - "Runtime Dependencies"
Cohesion: 0.17
Nodes (12): dependencies, @aws-sdk/client-s3@^3.1169.0, @aws-sdk/s3-request-presigner@^3.1169.0, esbuild@^0.28.2, pg@^8.23.1, react@^19.3.1, react-dom@^19.3.1, zod@^4.6.7 (+4 more)

### Community 12 - "UI Screenshot Concepts"
Cohesion: 0.18
Nodes (11): Legacy Bridge Your Projects Screenshot, Add Project Button (blue circular plus), Banking tools card (Taxes and Stocks, 4 of 5 stages, edited 2 days ago), Billing portal card (Invoicing and payments, all 5 stages complete, edited 1 week ago), Download and Delete Card Actions, Legacy Bridge Header Bar, Question Mark Badge (orange, on Banking tools), Inventory app card (Stock and ordering, 2 of 5 stages, edited 3 hours ago) (+3 more)

### Community 13 - "Docs: Plan, gVisor, Known Gaps"
Cohesion: 0.22
Nodes (9): gVisor (runsc) on a worker host, Spike F2 (harness x20, libfaketime, setarch -R, start latency), Legacy Bridge Backend Implementation Plan, Backend (slice S1), Known gaps (gVisor, LB_SANDBOX=direct, S7 login, S2 Ghidra/REA, S4 generation, UI not wired), Legacy Bridge, Test suite (unit, API, e2e, PostgreSQL, S3 integration), UI prototype (Next.js App Router + React) (+1 more)

### Community 14 - "package.json Metadata"
Cohesion: 0.18
Nodes (10): author, bugs, url, description, homepage, keywords, license, name (+2 more)

### Community 15 - "wordfreq C Fixture"
Cohesion: 0.28
Nodes (3): add(), main(), stopped()

### Community 16 - "npm Scripts"
Cohesion: 0.22
Nodes (9): scripts, build, dev, fixtures, migrate, start, test, typecheck (+1 more)

### Community 17 - "wordfreq TS Replacement"
Cohesion: 0.33
Nodes (6): atoi(), run(), RunDeps, RunInput, RunOutput, USAGE

### Community 18 - "compare package.json"
Cohesion: 0.29
Nodes (6): main, name, private, type, types, version

### Community 19 - "contracts package.json"
Cohesion: 0.29
Nodes (6): main, name, private, type, types, version

### Community 20 - "Root Layout"
Cohesion: 0.33
Nodes (3): metadata, next@^16.4.6, next

### Community 21 - "API Route [jid]"
Cohesion: 0.40
Nodes (4): dynamic, GET, runtime, api

### Community 22 - "API Route [pid]"
Cohesion: 0.40
Nodes (4): DELETE, dynamic, GET, runtime

### Community 23 - "API Route scope-draft"
Cohesion: 0.40
Nodes (4): dynamic, GET, PUT, runtime

### Community 24 - "API Route projects"
Cohesion: 0.40
Nodes (4): dynamic, GET, POST, runtime

### Community 25 - "API Route download"
Cohesion: 0.50
Nodes (3): dynamic, GET, runtime

### Community 26 - "API Route [eid]"
Cohesion: 0.50
Nodes (3): dynamic, GET, runtime

### Community 27 - "API Route cancel"
Cohesion: 0.50
Nodes (3): dynamic, POST, runtime

### Community 28 - "API Route builds"
Cohesion: 0.50
Nodes (3): dynamic, GET, runtime

### Community 29 - "API Route [...path]"
Cohesion: 0.50
Nodes (3): dynamic, GET, runtime

### Community 30 - "API Route [mid]"
Cohesion: 0.50
Nodes (3): dynamic, GET, runtime

### Community 31 - "API Route activity"
Cohesion: 0.50
Nodes (3): dynamic, GET, runtime

### Community 32 - "API Route [sha]"
Cohesion: 0.50
Nodes (3): dynamic, GET, runtime

### Community 33 - "API Route case-set-revisions"
Cohesion: 0.50
Nodes (3): dynamic, POST, runtime

### Community 34 - "API Route comparison-policies"
Cohesion: 0.50
Nodes (3): dynamic, POST, runtime

### Community 35 - "API Route exports"
Cohesion: 0.50
Nodes (3): dynamic, POST, runtime

### Community 36 - "API Route module-revisions"
Cohesion: 0.50
Nodes (3): dynamic, POST, runtime

### Community 37 - "API Route reference-captures"
Cohesion: 0.50
Nodes (3): dynamic, POST, runtime

### Community 38 - "API Route scope-revisions"
Cohesion: 0.50
Nodes (3): dynamic, POST, runtime

### Community 39 - "API Route source-revisions"
Cohesion: 0.50
Nodes (3): dynamic, POST, runtime

### Community 40 - "API Route test-cases"
Cohesion: 0.50
Nodes (3): dynamic, POST, runtime

### Community 41 - "API Route uploads"
Cohesion: 0.50
Nodes (3): dynamic, POST, runtime

### Community 42 - "API Route verification-runs"
Cohesion: 0.50
Nodes (3): dynamic, POST, runtime

### Community 43 - "API Route decision"
Cohesion: 0.50
Nodes (3): dynamic, POST, runtime

### Community 44 - "API Route execution-consent"
Cohesion: 0.50
Nodes (3): dynamic, POST, runtime

### Community 45 - "API Route probe"
Cohesion: 0.50
Nodes (3): dynamic, POST, runtime

### Community 46 - "API Route [sid]"
Cohesion: 0.50
Nodes (3): dynamic, GET, runtime

### Community 47 - "API Route reference-outputs"
Cohesion: 0.50
Nodes (3): dynamic, POST, runtime

### Community 48 - "API Route complete"
Cohesion: 0.50
Nodes (3): dynamic, POST, runtime

### Community 49 - "API Route results"
Cohesion: 0.50
Nodes (3): dynamic, GET, runtime

### Community 50 - "API Route [vrid]"
Cohesion: 0.50
Nodes (3): dynamic, GET, runtime

### Community 52 - "Repository Metadata"
Cohesion: 0.67
Nodes (3): repository, type, url

## Ambiguous Edges - Review These
- `Five-step Progress Indicator` → `Question Mark Badge (orange, on Banking tools)`  [AMBIGUOUS]
  Screenshot 2026-11-14 105744.png · relation: conceptually_related_to

## Knowledge Gaps
- **10 isolated node(s):** `RFC-9457`, `RFC-9562`, `Legacy Bridge`, `Test suite (unit, API, e2e, PostgreSQL, S3 integration)`, `Legacy Bridge Your Projects Screenshot` (+5 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 297 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `react` connect `Prototype UI (Next.js)` to `Runtime Dependencies`, `Root Layout`, `package.json Metadata`?**
  _High betweenness centrality (0.119) - this node is a cross-community bridge._
- **What connects `RFC-9457`, `RFC-9562`, `Legacy Bridge` to the rest of the system?**
  _10 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `API Handlers & Route Helpers` be split into smaller, more focused modules?**
  _Cohesion score 0.06908140403286034 - nodes in this community are weakly interconnected._
- **Why does `vitest` connect `App Wiring & Test Tooling` to `API Handlers & Route Helpers`, `Worker Handlers & Blob Storage`, `Compare Engine`, `Status Contracts`, `Tar & Export Zip`, `Dev Dependencies`, `package.json Metadata`?**
  _High betweenness centrality (0.103) - this node is a cross-community bridge._
- **Should `Worker Handlers & Blob Storage` be split into smaller, more focused modules?**
  _Cohesion score 0.06126126126126126 - nodes in this community are weakly interconnected._
- **Why does `zod` connect `Compare Engine` to `API Handlers & Route Helpers`, `Runtime Dependencies`, `package.json Metadata`, `Status Contracts`?**
  _High betweenness centrality (0.094) - this node is a cross-community bridge._

### Low-confidence Hints
_AMBIGUOUS edges — the extractor was unsure. Verify before acting on these._

- **What is the exact relationship between `Five-step Progress Indicator` and `Question Mark Badge (orange, on Banking tools)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._