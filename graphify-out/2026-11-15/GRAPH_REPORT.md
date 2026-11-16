# Graph Report - Hacktopus-Legacy-Bridge  (2026-11-14)

## Corpus Check
- 249 files · ~119,708 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 11 file(s) not represented in the graph (top: (none) 8, .example 1, .css 1)

## Summary
- 1541 nodes · 4173 edges · 106 communities (103 shown, 3 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 86 edges (avg confidence: 0.87)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `20da9332`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- handlers.ts
- BlobStore
- runtime.ts
- ContextPanel.tsx
- contracts/src/index.ts
- Select.tsx
- Docker Compose Infra
- Status Contracts
- export/build.ts
- tsconfig Settings
- Dev Dependencies
- Runtime Dependencies
- UI Screenshot Concepts
- wordfreq.c
- run.ts
- scope.test.ts
- npm Scripts
- wordfreq TS Replacement
- compare package.json
- contracts package.json
- react
- API Route [jid]
- API Route [pid]
- API Route scope-draft
- API Route projects
- API Route download
- runners.ts
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
- engine.ts
- API Route results
- API Route [vrid]
- Next Config
- Repository Metadata
- analysis.test.ts
- s1-client.ts
- EvidencePanel.tsx
- codex-jobs.ts
- StagePage
- StageFrame.tsx
- generation.test.ts
- api
- 3. Domain model and persistence
- Legacy Bridge — Backend Implementation Plan (with implementation status)
- 7. Execution and verification design
- auth.test.ts
- f1-runner.mjs
- uuidv7
- codex.ts
- 12. Decisions and open questions
- 1. Backend scope and MVP boundary
- 2. Recommended architecture
- 4. State machines and invariants
- verification.ts
- Db
- analysis-runs/route.ts
- 10. Implementation sequence
- 6. Analysis and generation integration
- verification.test.ts
- common.ts
- Windows F3 handoff · stripped intcalc
- analysis.ts
- export.test.ts
- gVisor (runsc) on a worker host
- queue.ts
- package.json
- f1-analysis-spike.md
- replay.ts
- purge.test.ts
- BlobStore
- api.test.ts
- ctx.ts
- Windows handoff: Ghidra evidence and F3 on stripped `intcalc`
- Full untranslated lists
- ImportStage.tsx
- intcalc-naive/src/index.ts
- [member]/route.ts
- members/route.ts
- org/route.ts
- [rid]/route.ts
- healthz/route.ts
- validate.ts
- v1/exports/[eid]/route.ts
- audit-events/route.ts
- [rsid]/route.ts
- AGENTS.md
- @electric-sql/pglite

## God Nodes (most connected - your core abstractions)
1. `uuidv7()` - 66 edges
2. `DomainError` - 66 edges
3. `api` - 48 edges
4. `Db` - 47 edges
5. `getHeads()` - 42 edges
6. `vitest` - 33 edges
7. `WorkerEnv` - 29 edges
8. `FsBlobStore` - 28 edges
9. `projectPath()` - 27 edges
10. `BlobStore` - 27 edges

## Surprising Connections (you probably didn't know these)
- `What exists vs. what is proposed (repository inspection, commit `4c52d2b`)` --references--> `downloadPlan()`  [INFERRED]
  docs/backend-plan.md → lib/projects.ts
- `0. Recommended MVP architecture and first vertical slice (summary)` --references--> `verify()`  [INFERRED]
  docs/backend-plan.md → tests/e2e/s5-verification.test.ts
- `12.1 Major decisions` --references--> `CodeGenerator`  [INFERRED]
  docs/backend-plan.md → workers/generation/provider.ts
- `Invariants to keep (plan §4.4)` --references--> `judge()`  [INFERRED]
  CLAUDE.md → packages/compare/src/judge.ts
- `Legacy Bridge — Backend Implementation Plan (with implementation status)` --references--> `Db`  [INFERRED]
  docs/backend-plan.md → server/db/db.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Project cards on the Your Projects screen** — screenshot_2026_11_14_105744_banking_tools, screenshot_2026_11_14_105744_billing_portal, screenshot_2026_11_14_105744_inventory_app [EXTRACTED 1.00]

## Communities (106 total, 3 thin omitted)

### Community 0 - "handlers.ts"
Cohesion: 0.13
Nodes (34): analysisRequest, live(), LiveTable, P, pid(), projectOf(), sha, text (+26 more)

### Community 1 - "BlobStore"
Cohesion: 0.19
Nodes (5): assertSafe(), blobKey(), stagingKey(), FsBlobStore, S3BlobStore

### Community 2 - "runtime.ts"
Cohesion: 0.14
Nodes (26): purgeExpired(), Job, retryOrFail(), putBlob(), observation(), OriginalRunner, buildHandler(), sha() (+18 more)

### Community 3 - "ContextPanel.tsx"
Cohesion: 0.29
Nodes (14): ContextPanel(), attachMedia(), onDrag(), useAttachment(), Props, saveRaw(), accessAttachments(), addAttachments() (+6 more)

### Community 4 - "contracts/src/index.ts"
Cohesion: 0.11
Nodes (16): RFC-9457, CompareResult, ObservationData, sha256(), RunLike, Channel, Observation, Outcome (+8 more)

### Community 5 - "Select.tsx"
Cohesion: 0.13
Nodes (26): Evidence(), NoteList(), Props, replaceAt(), ScopeEditor(), short(), without(), Candidate (+18 more)

### Community 6 - "Docker Compose Infra"
Cohesion: 0.07
Nodes (28): context, dockerfile, COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS, POSTGRES_DB, POSTGRES_PASSWORD, POSTGRES_USER, environment, image (+20 more)

### Community 7 - "Status Contracts"
Cohesion: 0.11
Nodes (22): AnalysisEligibility, ArtifactRole, ExecutionEligibility, JobKind, JobStatus, Role, bin(), image (+14 more)

### Community 8 - "export/build.ts"
Cohesion: 0.09
Nodes (26): canonical(), citedFindingIds(), oct(), packTar(), pad(), unpackTar(), exp(), buildExport() (+18 more)

### Community 9 - "tsconfig Settings"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 10 - "Dev Dependencies"
Cohesion: 0.12
Nodes (16): devDependencies, fast-check@^4.10.2, tsx@^4.23.15, @types/node@^26.6.6, @types/pg@^8.23.1, @types/react@^19.3.0, @types/react-dom@^19.3.0, typescript@^7.0.2 (+8 more)

### Community 11 - "Runtime Dependencies"
Cohesion: 0.15
Nodes (13): dependencies, @auth/core@^0.41.3, @aws-sdk/client-s3@^3.1169.0, @aws-sdk/s3-request-presigner@^3.1169.0, esbuild@^0.28.2, next@^16.4.6, react@^19.3.1, react-dom@^19.3.1 (+5 more)

### Community 12 - "UI Screenshot Concepts"
Cohesion: 0.18
Nodes (11): Legacy Bridge Your Projects Screenshot, Add Project Button (blue circular plus), Banking tools card (Taxes and Stocks, 4 of 5 stages, edited 2 days ago), Billing portal card (Invoicing and payments, all 5 stages complete, edited 1 week ago), Download and Delete Card Actions, Legacy Bridge Header Bar, Question Mark Badge (orange, on Banking tools), Inventory app card (Stock and ordering, 2 of 5 stages, edited 3 hours ago) (+3 more)

### Community 13 - "wordfreq.c"
Cohesion: 0.14
Nodes (8): calculate(), main(), parse_input(), main(), read_random(), add(), main(), stopped()

### Community 14 - "run.ts"
Cohesion: 0.12
Nodes (14): Isolation (read before touching runners or the worker image), Current state, Legacy Bridge Codex handoff, Next run on the actual two laptops, Reproduce locally, What was verified, Where to start in the code, Basis (+6 more)

### Community 15 - "scope.test.ts"
Cohesion: 0.11
Nodes (24): createScopeRevision(), decideScope(), HEAD_COLUMNS, HeadName, Heads, putScopeDraft(), validateScopeEvidence(), getScopeRevision() (+16 more)

### Community 16 - "npm Scripts"
Cohesion: 0.17
Nodes (12): scripts, bootstrap-admin, build, dev, fixtures, migrate, s1:seed, start (+4 more)

### Community 17 - "wordfreq TS Replacement"
Cohesion: 0.33
Nodes (6): atoi(), run(), RunDeps, RunInput, RunOutput, USAGE

### Community 18 - "compare package.json"
Cohesion: 0.29
Nodes (6): main, name, private, type, types, version

### Community 19 - "contracts package.json"
Cohesion: 0.29
Nodes (6): main, name, private, type, types, version

### Community 20 - "react"
Cohesion: 0.09
Nodes (39): metadata, RootLayout(), Page(), Layout(), PrototypeResume(), ResumeProject(), Icon(), icons (+31 more)

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

### Community 26 - "runners.ts"
Cohesion: 0.14
Nodes (15): COMPARE_ENGINE_VERSION, judge(), LIMITS, runCase(), safeJoin(), sha(), Snap, walk() (+7 more)

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
Cohesion: 0.40
Nodes (4): dynamic, GET, POST, runtime

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

### Community 48 - "engine.ts"
Cohesion: 0.19
Nodes (17): compare(), compareBytes(), countChanged(), empty(), excerpt(), firstDifference(), globToRegExp(), listFiles() (+9 more)

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
Nodes (49): analyze(), assertProvenance(), call(), Finding, findings(), Handler, ok(), outsider (+41 more)

### Community 54 - "s1-client.ts"
Cohesion: 0.24
Nodes (16): S1Home(), act(), create(), download(), refresh(), remove(), check(), Identity (+8 more)

### Community 55 - "EvidencePanel.tsx"
Cohesion: 0.10
Nodes (30): active(), addressOf(), AnalysisRun, Candidate, Citation, EvidencePanel(), FindingDetail(), FindingDetails (+22 more)

### Community 56 - "codex-jobs.ts"
Cohesion: 0.06
Nodes (46): runtime, runtime, runtime, runtime, runtime, runtime, Commands, Conventions (+38 more)

### Community 57 - "StagePage"
Cohesion: 0.17
Nodes (18): Page(), Page(), Page(), Page(), Page(), S1Stage(), useOperation(), StagePage() (+10 more)

### Community 58 - "StageFrame.tsx"
Cohesion: 0.13
Nodes (30): indexArtifact(), requestPseudocode(), Export(), build(), download(), Import(), choose(), upload() (+22 more)

### Community 59 - "generation.test.ts"
Cohesion: 0.07
Nodes (36): ScopeDocV1, cancel(), call(), editor, fake, generate(), org, other (+28 more)

### Community 60 - "api"
Cohesion: 0.12
Nodes (12): GET, runtime, GET, runtime, GET, runtime, GET, runtime (+4 more)

### Community 61 - "3. Domain model and persistence"
Cohesion: 0.18
Nodes (11): 3.10 Immutability, lineage, isolation, retention, deletion, 3.1 Tenancy and access, 3.2 Artifacts and source revisions, 3.3 Analysis runs, findings, evidence, 3.4 Scope/interface revisions and approvals, 3.5 Module revisions and builds, 3.6 Test cases, references, case sets, 3.7 Environments and comparison policies (+3 more)

### Community 62 - "Legacy Bridge — Backend Implementation Plan (with implementation status)"
Cohesion: 0.09
Nodes (22): 0. Recommended MVP architecture and first vertical slice (summary), 11.1 Fixtures (C sources in `fixtures/src`, built reproducibly in a pinned `gcc` image; stripped and unstripped variants), 11.2 How each property is validated, 11. Validation strategy, 5.1 Cross-cutting, 5.2 Endpoints (representative payloads), 5. UI-facing API contracts, 8.1 Untrusted execution and parsing (+14 more)

### Community 63 - "7. Execution and verification design"
Cohesion: 0.25
Nodes (8): 7.1 Observation contract (shared by original, replacement, and exported replay), 7.2 Harnesses, 7.3 Environment, dependencies, state reset, controls, 7.4 Reference capture and provenance, 7.5 Comparison (`packages/compare`, pure, versioned semver), 7.6 Replay outside the product, 7.7 What "Match" establishes and what it does not, 7. Execution and verification design

### Community 64 - "auth.test.ts"
Cohesion: 0.21
Nodes (10): handler(), runtime, @auth/core, getApp(), AUTH_BASE_PATH, authConfig(), sessionUserId(), IdpProfile (+2 more)

### Community 65 - "f1-runner.mjs"
Cohesion: 0.29
Nodes (6): all, benchmark(), dataSize(), operations, selected, suites

### Community 66 - "uuidv7"
Cohesion: 0.17
Nodes (26): uuidv7(), digest(), assertExecutionPermitted(), CaseSpec, createCaseSet(), createPolicy(), createTestCase(), requestCapture() (+18 more)

### Community 67 - "codex.ts"
Cohesion: 0.14
Nodes (12): moduleOutput, request, success, CodexGenerator, codexModuleSchema, Event, events(), ExecOptions (+4 more)

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

### Community 72 - "verification.ts"
Cohesion: 0.18
Nodes (10): bindingDigest(), BindingInput, StaleReason, VerifyRequest, doc, orgA, orgB, proj (+2 more)

### Community 73 - "Db"
Cohesion: 0.12
Nodes (20): pg@^8.23.1, pg, bootstrapAdmin(), db, API_ROLE, assertOrgId(), Db, db (+12 more)

### Community 74 - "analysis-runs/route.ts"
Cohesion: 0.50
Nodes (3): GET, POST, runtime

### Community 75 - "10. Implementation sequence"
Cohesion: 0.50
Nodes (4): 10.0 Proposed repository layout (new areas), 10.1 Feasibility experiments (timeboxed, before S2+; F2 and F4 before S1 completes), 10.2 Slices, 10. Implementation sequence

### Community 76 - "6. Analysis and generation integration"
Cohesion: 0.50
Nodes (4): 6.1 Analysis adapter, 6.2 What REA provides vs. what we build vs. unknowns, 6.3 Generation adapter, 6. Analysis and generation integration

### Community 77 - "verification.test.ts"
Cohesion: 0.14
Nodes (9): calls, counting, noDuplicates(), org, project, results(), root, src (+1 more)

### Community 78 - "common.ts"
Cohesion: 0.23
Nodes (17): CaseInput, CaseSetEntry, finalizeRun(), recordResult(), RunOutcome, captureHandler(), jobDir(), loadObservation() (+9 more)

### Community 79 - "Windows F3 handoff · stripped intcalc"
Cohesion: 0.17
Nodes (8): Experiment, Final verification, Per-run outcomes, Selecting the function, Setup and measurement, What pseudocode changed, Windows Docker analysis timings, Windows F3 handoff · stripped intcalc

### Community 80 - "analysis.ts"
Cohesion: 0.17
Nodes (24): AnalysisRequest, evidenceBundle(), FINDING_KINDS, FindingKind, FindingRow, getFinding(), getRawEvidence(), listCandidates() (+16 more)

### Community 81 - "export.test.ts"
Cohesion: 0.08
Nodes (36): RFC-9562, CONTROLS, ensureEnvironment(), EnvDef, createExport(), completeUpload(), createUpload(), recordExecutionConsent() (+28 more)

### Community 82 - "gVisor (runsc) on a worker host"
Cohesion: 0.22
Nodes (9): gVisor (runsc) on a worker host, Spike F2 (harness x20, libfaketime, setarch -R, start latency), Legacy Bridge Backend Implementation Plan, Backend (slice S1), Known gaps (gVisor, LB_SANDBOX=direct, S7 login, S2 Ghidra/REA, S4 generation, UI not wired), Legacy Bridge, Test suite (unit, API, e2e, PostgreSQL, S3 integration), UI prototype (Next.js App Router + React) (+1 more)

### Community 83 - "queue.ts"
Cohesion: 0.21
Nodes (14): POST, runtime, command, generationWorkerCommand(), lease, noStore, readBody(), workerCommand() (+6 more)

### Community 84 - "package.json"
Cohesion: 0.18
Nodes (10): author, bugs, url, description, homepage, keywords, license, name (+2 more)

### Community 85 - "f1-analysis-spike.md"
Cohesion: 0.20
Nodes (7): Commands and result shapes, F1 · REA and Ghidra feasibility, Inputs and method, Reproduce, Results, f1-fixtures.sh script, f1-oci.sh script

### Community 86 - "replay.ts"
Cohesion: 0.16
Nodes (23): pkg(), put(), root, tmp(), RunRequest, hardeningArgs(), dockerBuildArgs(), dockerFailure() (+15 more)

### Community 87 - "purge.test.ts"
Cohesion: 0.22
Nodes (7): blob(), exists(), orgA, orgB, seedProject(), uniques(), user

### Community 88 - "BlobStore"
Cohesion: 0.13
Nodes (10): deleteBlobs(), GRACE_DAYS, PROJECT_DELETES, PurgeOptions, purgeProject(), PurgeReport, referencedBlobs(), requirePurgeRole() (+2 more)

### Community 89 - "api.test.ts"
Cohesion: 0.08
Nodes (24): vitest, App, setApp(), PresignedPut, A, B, call(), ids (+16 more)

### Community 90 - "ctx.ts"
Cohesion: 0.16
Nodes (19): Ctx, GenerationInput, requestGeneration(), getOrg(), listAuditEvents(), ORG_SETTINGS, OrgSetting, patchOrg() (+11 more)

### Community 91 - "Windows handoff: Ghidra evidence and F3 on stripped `intcalc`"
Cohesion: 0.25
Nodes (8): Baseline already recorded (no decompiler evidence), Goal, Limits to state in any report, Prerequisites, Steps (PowerShell, from the repo root), What to report back, Why Windows, Windows handoff: Ghidra evidence and F3 on stripped `intcalc`

### Community 92 - "Full untranslated lists"
Cohesion: 0.29
Nodes (7): Baseline 1, Baseline 2, Baseline 3, Evidence 1, Evidence 2, Evidence 3, Full untranslated lists

### Community 93 - "ImportStage.tsx"
Cohesion: 0.24
Nodes (8): AnalysisPanel(), ImportStage(), onDrag(), selectFile(), detectExecutable(), ExecutableKind, notExecutableMessage, readExecutableKind()

### Community 94 - "intcalc-naive/src/index.ts"
Cohesion: 0.33
Nodes (6): parse(), run(), RunDeps, RunInput, RunOutput, USAGE

### Community 95 - "[member]/route.ts"
Cohesion: 0.40
Nodes (4): DELETE, dynamic, PATCH, runtime

### Community 96 - "members/route.ts"
Cohesion: 0.40
Nodes (4): dynamic, GET, POST, runtime

### Community 97 - "org/route.ts"
Cohesion: 0.40
Nodes (4): dynamic, GET, PATCH, runtime

### Community 98 - "[rid]/route.ts"
Cohesion: 0.50
Nodes (3): dynamic, GET, runtime

### Community 99 - "healthz/route.ts"
Cohesion: 0.40
Nodes (4): dynamic, GET, runtime, healthz()

### Community 100 - "validate.ts"
Cohesion: 0.50
Nodes (3): Untranslated, GenerationOutputInvalid, validateGenerated()

### Community 101 - "v1/exports/[eid]/route.ts"
Cohesion: 0.50
Nodes (3): dynamic, GET, runtime

### Community 102 - "audit-events/route.ts"
Cohesion: 0.50
Nodes (3): dynamic, GET, runtime

### Community 103 - "[rsid]/route.ts"
Cohesion: 0.50
Nodes (3): dynamic, GET, runtime

## Ambiguous Edges - Review These
- `Question Mark Badge (orange, on Banking tools)` → `Five-step Progress Indicator`  [AMBIGUOUS]
  Screenshot 2026-11-14 105744.png · relation: conceptually_related_to

## Knowledge Gaps
- **10 isolated node(s):** `RFC-9457`, `RFC-9562`, `Add Project Button (blue circular plus)`, `Billing portal card (Invoicing and payments, all 5 stages complete, edited 1 week ago)`, `Download and Delete Card Actions` (+5 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 643 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `vitest` connect `api.test.ts` to `BlobStore`, `contracts/src/index.ts`, `Select.tsx`, `Status Contracts`, `export/build.ts`, `Dev Dependencies`, `scope.test.ts`, `analysis.test.ts`, `generation.test.ts`, `auth.test.ts`, `codex.ts`, `verification.ts`, `Db`, `verification.test.ts`, `analysis.ts`, `export.test.ts`, `package.json`, `replay.ts`, `purge.test.ts`?**
  _High betweenness centrality (0.104) - this node is a cross-community bridge._
- **What connects `RFC-9457`, `RFC-9562`, `Add Project Button (blue circular plus)` to the rest of the system?**
  _10 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `handlers.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.12692307692307692 - nodes in this community are weakly interconnected._
- **Why does `react` connect `react` to `ContextPanel.tsx`, `Select.tsx`, `Runtime Dependencies`, `package.json`, `s1-client.ts`, `EvidencePanel.tsx`, `codex-jobs.ts`, `StagePage`, `StageFrame.tsx`, `ImportStage.tsx`?**
  _High betweenness centrality (0.100) - this node is a cross-community bridge._
- **Should `runtime.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.1423076923076923 - nodes in this community are weakly interconnected._
- **Why does `Legacy Bridge — Backend Implementation Plan (with implementation status)` connect `Legacy Bridge — Backend Implementation Plan (with implementation status)` to `handlers.ts`, `BlobStore`, `12. Decisions and open questions`, `1. Backend scope and MVP boundary`, `2. Recommended architecture`, `4. State machines and invariants`, `Db`, `10. Implementation sequence`, `6. Analysis and generation integration`, `Windows F3 handoff · stripped intcalc`, `codex-jobs.ts`, `generation.test.ts`, `3. Domain model and persistence`, `7. Execution and verification design`?**
  _High betweenness centrality (0.100) - this node is a cross-community bridge._

### Low-confidence Hints
_AMBIGUOUS edges — the extractor was unsure. Verify before acting on these._

- **What is the exact relationship between `Question Mark Badge (orange, on Banking tools)` and `Five-step Progress Indicator`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._