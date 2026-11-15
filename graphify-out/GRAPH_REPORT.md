# Graph Report - Hacktopus-Legacy-Bridge  (2026-11-14)

## Corpus Check
- 186 files · ~72,414 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 10 file(s) not represented in the graph (top: (none) 8, .example 1, .css 1)

## Summary
- 1131 nodes · 2813 edges · 80 communities (75 shown, 5 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 61 edges (avg confidence: 0.87)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `213d68bd`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- API Handlers & Route Helpers
- BlobStore
- Job Queue & Case Domain
- ContextPanel.tsx
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
- lib/projects.ts
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
- analysis.test.ts
- s1-client.ts
- EvidencePanel.tsx
- s1.ts
- StagePage
- StageFrame.tsx
- codex-worker.ts
- api
- 3. Domain model and persistence
- Legacy Bridge — Backend Implementation Plan (with implementation status)
- 7. Execution and verification design
- 8. Security and operational requirements
- f1-runner.mjs
- f1-analysis-spike.md
- intcalc.c
- 12. Decisions and open questions
- 1. Backend scope and MVP boundary
- 2. Recommended architecture
- 4. State machines and invariants
- F1 · REA and Ghidra feasibility
- rand.c
- analysis-runs/route.ts
- 10. Implementation sequence
- 6. Analysis and generation integration
- 9. Export contract
- tsx@^4.23.15
- typescript@^7.0.2

## God Nodes (most connected - your core abstractions)
1. `DomainError` - 50 edges
2. `uuidv7()` - 44 edges
3. `api` - 38 edges
4. `getHeads()` - 32 edges
5. `Db` - 28 edges
6. `digest()` - 24 edges
7. `react` - 23 edges
8. `projectPath()` - 22 edges
9. `BlobStore` - 21 edges
10. `vitest` - 19 edges

## Surprising Connections (you probably didn't know these)
- `What exists vs. what is proposed (repository inspection, commit `4c52d2b`)` --references--> `downloadPlan()`  [INFERRED]
  docs/backend-plan.md → lib/projects.ts
- `Invariants to keep (plan §4.4)` --references--> `judge()`  [INFERRED]
  CLAUDE.md → packages/compare/src/judge.ts
- `Legacy Bridge — Backend Implementation Plan (with implementation status)` --references--> `Db`  [INFERRED]
  docs/backend-plan.md → server/db/db.ts
- `Invariants to keep (plan §4.4)` --references--> `bindingDigest()`  [INFERRED]
  CLAUDE.md → server/domain/verification.ts
- `Gotchas learned the hard way` --references--> `route()`  [INFERRED]
  CLAUDE.md → server/http/handler.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Project cards on the Your Projects screen** — screenshot_2026_11_14_105744_banking_tools, screenshot_2026_11_14_105744_billing_portal, screenshot_2026_11_14_105744_inventory_app [EXTRACTED 1.00]

## Communities (80 total, 5 thin omitted)

### Community 0 - "API Handlers & Route Helpers"
Cohesion: 0.05
Nodes (108): RFC-9562, COMPARE_ENGINE_VERSION, analysisRequest, P, pid(), projectOf(), sha, text (+100 more)

### Community 1 - "BlobStore"
Cohesion: 0.13
Nodes (8): App, assertSafe(), blobKey(), BlobStore, PresignedPut, stagingKey(), FsBlobStore, S3BlobStore

### Community 2 - "Job Queue & Case Domain"
Cohesion: 0.06
Nodes (68): Isolation (read before touching runners or the worker image), judge(), CaseInput, CaseSetEntry, CONTROLS, ensureEnvironment(), EnvDef, finalizeRun() (+60 more)

### Community 3 - "ContextPanel.tsx"
Cohesion: 0.17
Nodes (18): AnalysisPanel(), ContextPanel(), attachMedia(), onDrag(), useAttachment(), Props, Icon(), icons (+10 more)

### Community 4 - "Compare Engine"
Cohesion: 0.06
Nodes (46): RFC-9457, zod@^4.6.7, compare(), compareBytes(), CompareResult, countChanged(), empty(), excerpt() (+38 more)

### Community 5 - "App Wiring & Test Tooling"
Cohesion: 0.08
Nodes (33): runtime, runtime, pg@^8.23.1, pg, vitest, analysisStatus(), claimSchema, command (+25 more)

### Community 6 - "Docker Compose Infra"
Cohesion: 0.07
Nodes (28): context, dockerfile, COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS, POSTGRES_DB, POSTGRES_PASSWORD, POSTGRES_USER, environment, image (+20 more)

### Community 7 - "Status Contracts"
Cohesion: 0.11
Nodes (22): AnalysisEligibility, ArtifactRole, ExecutionEligibility, JobKind, JobStatus, Role, bin(), image (+14 more)

### Community 8 - "Tar & Export Zip"
Cohesion: 0.14
Nodes (14): oct(), packTar(), pad(), unpackTar(), buildExport(), BuiltExport, bundleHarness(), j() (+6 more)

### Community 9 - "tsconfig Settings"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 10 - "Dev Dependencies"
Cohesion: 0.14
Nodes (14): devDependencies, @electric-sql/pglite@^0.5.16, fast-check@^4.10.2, @types/node@^26.6.6, @types/pg@^8.23.1, @types/react@^19.3.0, @types/react-dom@^19.3.0, vitest@^5.1.0 (+6 more)

### Community 11 - "Runtime Dependencies"
Cohesion: 0.18
Nodes (11): dependencies, @aws-sdk/client-s3@^3.1169.0, @aws-sdk/s3-request-presigner@^3.1169.0, esbuild@^0.28.2, next@^16.4.6, react@^19.3.1, react-dom@^19.3.1, @aws-sdk/client-s3 (+3 more)

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
Cohesion: 0.38
Nodes (3): add(), main(), stopped()

### Community 16 - "npm Scripts"
Cohesion: 0.18
Nodes (11): scripts, build, dev, fixtures, migrate, s1:seed, start, test (+3 more)

### Community 17 - "wordfreq TS Replacement"
Cohesion: 0.33
Nodes (6): atoi(), run(), RunDeps, RunInput, RunOutput, USAGE

### Community 18 - "compare package.json"
Cohesion: 0.29
Nodes (6): main, name, private, type, types, version

### Community 19 - "contracts package.json"
Cohesion: 0.29
Nodes (6): main, name, private, type, types, version

### Community 20 - "lib/projects.ts"
Cohesion: 0.13
Nodes (32): metadata, RootLayout(), PrototypeResume(), ResumeProject(), Picker(), Progress(), Props, DialogState (+24 more)

### Community 21 - "API Route [jid]"
Cohesion: 0.50
Nodes (3): dynamic, GET, runtime

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

### Community 53 - "analysis.test.ts"
Cohesion: 0.07
Nodes (45): analyze(), assertProvenance(), call(), Finding, findings(), Handler, ok(), outsider (+37 more)

### Community 54 - "s1-client.ts"
Cohesion: 0.11
Nodes (29): Page(), Layout(), ProjectLayout(), saveRaw(), Export(), download(), S1Home(), act() (+21 more)

### Community 55 - "EvidencePanel.tsx"
Cohesion: 0.12
Nodes (27): active(), addressOf(), AnalysisRun, Candidate, Citation, EvidencePanel(), FindingDetail(), FindingDetails (+19 more)

### Community 56 - "s1.ts"
Cohesion: 0.11
Nodes (24): runtime, runtime, runtime, runtime, Commands, Conventions, Gotchas learned the hard way, Invariants to keep (plan §4.4) (+16 more)

### Community 57 - "StagePage"
Cohesion: 0.18
Nodes (15): Page(), Page(), Page(), Page(), Page(), S1Stage(), useOperation(), StagePage() (+7 more)

### Community 58 - "StageFrame.tsx"
Cohesion: 0.17
Nodes (22): indexArtifact(), requestPseudocode(), build(), Import(), probe(), upload(), Modernize(), build() (+14 more)

### Community 59 - "codex-worker.ts"
Cohesion: 0.17
Nodes (11): AnalysisResult, AnalysisStatus, MAX_ANALYSIS_BYTES, config(), Failure, Job, main(), processJob() (+3 more)

### Community 60 - "api"
Cohesion: 0.15
Nodes (9): GET, runtime, GET, runtime, GET, runtime, GET, runtime (+1 more)

### Community 61 - "3. Domain model and persistence"
Cohesion: 0.18
Nodes (11): 3.10 Immutability, lineage, isolation, retention, deletion, 3.1 Tenancy and access, 3.2 Artifacts and source revisions, 3.3 Analysis runs, findings, evidence, 3.4 Scope/interface revisions and approvals, 3.5 Module revisions and builds, 3.6 Test cases, references, case sets, 3.7 Environments and comparison policies (+3 more)

### Community 62 - "Legacy Bridge — Backend Implementation Plan (with implementation status)"
Cohesion: 0.20
Nodes (10): 0. Recommended MVP architecture and first vertical slice (summary), 11.1 Fixtures (C sources in `fixtures/src`, built reproducibly in a pinned `gcc` image; stripped and unstripped variants), 11.2 How each property is validated, 11. Validation strategy, 5.1 Cross-cutting, 5.2 Endpoints (representative payloads), 5. UI-facing API contracts, Context (+2 more)

### Community 63 - "7. Execution and verification design"
Cohesion: 0.25
Nodes (8): 7.1 Observation contract (shared by original, replacement, and exported replay), 7.2 Harnesses, 7.3 Environment, dependencies, state reset, controls, 7.4 Reference capture and provenance, 7.5 Comparison (`packages/compare`, pure, versioned semver), 7.6 Replay outside the product, 7.7 What "Match" establishes and what it does not, 7. Execution and verification design

### Community 64 - "8. Security and operational requirements"
Cohesion: 0.25
Nodes (8): 8.1 Untrusted execution and parsing, 8.2 Tenant isolation, 8.3 Credentials, 8.4 Temporary artifacts and sensitive logs, 8.5 Audit events (in `events`), 8.6 Observability, 8.7 Storage limits and quotas (MVP defaults, per org, configurable), 8. Security and operational requirements

### Community 65 - "f1-runner.mjs"
Cohesion: 0.29
Nodes (6): all, benchmark(), dataSize(), operations, selected, suites

### Community 67 - "intcalc.c"
Cohesion: 0.38
Nodes (3): calculate(), main(), parse_input()

### Community 68 - "12. Decisions and open questions"
Cohesion: 0.33
Nodes (6): 12.1 Major decisions, 12.2 Facts (verified in this session), 12.3 Assumptions, 12.4 Unresolved feasibility questions (answered by spikes), 12.5 Questions that would materially change implementation, 12. Decisions and open questions

### Community 69 - "1. Backend scope and MVP boundary"
Cohesion: 0.33
Nodes (6): 1.1 Choices, 1.2 Supported vs. unsupported inputs, 1.3 Prerequisites, 1.4 When execution is unavailable, 1.5 Non-goals (MVP), 1. Backend scope and MVP boundary

### Community 70 - "2. Recommended architecture"
Cohesion: 0.33
Nodes (6): 2.1 Components, 2.2 Diagram, 2.3 Trust and process boundaries, 2.4 Sync vs. async, 2.5 Deployment constraint that shapes the architecture, 2. Recommended architecture

### Community 71 - "4. State machines and invariants"
Cohesion: 0.40
Nodes (5): 4.1 Separate status dimensions (never collapsed into one field), 4.2 Lifecycles, 4.3 Failure and concurrency behavior, 4.4 Invariants (enforced by the backend regardless of UI), 4. State machines and invariants

### Community 72 - "F1 · REA and Ghidra feasibility"
Cohesion: 0.40
Nodes (5): Commands and result shapes, F1 · REA and Ghidra feasibility, Inputs and method, Reproduce, Results

### Community 74 - "analysis-runs/route.ts"
Cohesion: 0.50
Nodes (3): GET, POST, runtime

### Community 75 - "10. Implementation sequence"
Cohesion: 0.50
Nodes (4): 10.0 Proposed repository layout (new areas), 10.1 Feasibility experiments (timeboxed, before S2+; F2 and F4 before S1 completes), 10.2 Slices, 10. Implementation sequence

### Community 76 - "6. Analysis and generation integration"
Cohesion: 0.50
Nodes (4): 6.1 Analysis adapter, 6.2 What REA provides vs. what we build vs. unknowns, 6.3 Generation adapter, 6. Analysis and generation integration

### Community 77 - "9. Export contract"
Cohesion: 0.50
Nodes (4): 9.1 Package structure, 9.2 Manifest (abridged), 9.3 Integrity and reproducibility, 9. Export contract

## Ambiguous Edges - Review These
- `Question Mark Badge (orange, on Banking tools)` → `Five-step Progress Indicator`  [AMBIGUOUS]
  Screenshot 2026-11-14 105744.png · relation: conceptually_related_to

## Knowledge Gaps
- **10 isolated node(s):** `RFC-9457`, `RFC-9562`, `Add Project Button (blue circular plus)`, `Billing portal card (Invoicing and payments, all 5 stages complete, edited 1 week ago)`, `Download and Delete Card Actions` (+5 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 456 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Legacy Bridge — Backend Implementation Plan (with implementation status)` connect `Legacy Bridge — Backend Implementation Plan (with implementation status)` to `8. Security and operational requirements`, `BlobStore`, `f1-analysis-spike.md`, `12. Decisions and open questions`, `1. Backend scope and MVP boundary`, `2. Recommended architecture`, `4. State machines and invariants`, `App Wiring & Test Tooling`, `10. Implementation sequence`, `6. Analysis and generation integration`, `9. Export contract`, `3. Domain model and persistence`, `7. Execution and verification design`?**
  _High betweenness centrality (0.135) - this node is a cross-community bridge._
- **What connects `RFC-9457`, `RFC-9562`, `Add Project Button (blue circular plus)` to the rest of the system?**
  _10 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `API Handlers & Route Helpers` be split into smaller, more focused modules?**
  _Cohesion score 0.05330948121645796 - nodes in this community are weakly interconnected._
- **Why does `react` connect `lib/projects.ts` to `ContextPanel.tsx`, `Runtime Dependencies`, `package.json Metadata`, `s1-client.ts`, `EvidencePanel.tsx`, `StagePage`, `StageFrame.tsx`, `codex-worker.ts`?**
  _High betweenness centrality (0.119) - this node is a cross-community bridge._
- **Should `BlobStore` be split into smaller, more focused modules?**
  _Cohesion score 0.13213213213213212 - nodes in this community are weakly interconnected._
- **Why does `Db` connect `App Wiring & Test Tooling` to `API Handlers & Route Helpers`, `BlobStore`, `Job Queue & Case Domain`, `Tar & Export Zip`, `Legacy Bridge — Backend Implementation Plan (with implementation status)`?**
  _High betweenness centrality (0.094) - this node is a cross-community bridge._

### Low-confidence Hints
_AMBIGUOUS edges — the extractor was unsure. Verify before acting on these._

- **What is the exact relationship between `Question Mark Badge (orange, on Banking tools)` and `Five-step Progress Indicator`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._