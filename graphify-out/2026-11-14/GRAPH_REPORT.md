# Graph Report - Hacktopus-Legacy-Bridge  (2026-11-14)

## Corpus Check
- 208 files · ~86,995 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 10 file(s) not represented in the graph (top: (none) 8, .example 1, .css 1)

## Summary
- 1296 nodes · 3362 edges · 102 communities (95 shown, 7 thin omitted)
- Extraction: 98% EXTRACTED · 2% INFERRED · 0% AMBIGUOUS · INFERRED: 69 edges (avg confidence: 0.87)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `622aa899`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- handlers.ts
- BlobStore
- runtime.ts
- ContextPanel.tsx
- Compare Engine
- codex-jobs.ts
- Docker Compose Infra
- Status Contracts
- Tar & Export Zip
- tsconfig Settings
- Dev Dependencies
- Runtime Dependencies
- UI Screenshot Concepts
- wordfreq.c
- package.json Metadata
- scope.test.ts
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
- cases.ts
- codex.ts
- 12. Decisions and open questions
- 1. Backend scope and MVP boundary
- 2. Recommended architecture
- 4. State machines and invariants
- Select.tsx
- run.ts
- analysis-runs/route.ts
- 10. Implementation sequence
- 6. Analysis and generation integration
- 9. Export contract
- common.ts
- typescript@^7.0.2
- analysis.ts
- import-to-export.test.ts
- generation.test.ts
- queue.test.ts
- ScopeEditor.tsx
- codex-generation.ts
- ref_node_fs
- analysis.test.ts
- BlobStore
- api.test.ts
- generate.ts
- rea-analysis.test.ts
- handler.ts
- ImportStage.tsx
- Legacy Bridge
- AnalysisPanel.tsx
- Legacy Bridge Codex handoff
- CodeGenerator
- [rid]/route.ts
- findings/route.ts
- problem.ts
- @types/react-dom@^19.3.0

## God Nodes (most connected - your core abstractions)
1. `DomainError` - 56 edges
2. `uuidv7()` - 49 edges
3. `api` - 40 edges
4. `getHeads()` - 40 edges
5. `Db` - 33 edges
6. `digest()` - 26 edges
7. `react` - 25 edges
8. `BlobStore` - 24 edges
9. `projectPath()` - 24 edges
10. `Select()` - 23 edges

## Surprising Connections (you probably didn't know these)
- `12.1 Major decisions` --references--> `CodeGenerator`  [INFERRED]
  docs/backend-plan.md → workers/generation/provider.ts
- `2.1 Components` --references--> `CodeGenerator`  [INFERRED]
  docs/backend-plan.md → workers/generation/provider.ts
- `What exists vs. what is proposed (repository inspection, commit `4c52d2b`)` --references--> `downloadPlan()`  [INFERRED]
  docs/backend-plan.md → lib/projects.ts
- `Legacy Bridge — Backend Implementation Plan (with implementation status)` --references--> `CodeGenerator`  [INFERRED]
  docs/backend-plan.md → workers/generation/provider.ts
- `Invariants to keep (plan §4.4)` --references--> `judge()`  [INFERRED]
  CLAUDE.md → packages/compare/src/judge.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Project cards on the Your Projects screen** — screenshot_2026_11_14_105744_banking_tools, screenshot_2026_11_14_105744_billing_portal, screenshot_2026_11_14_105744_inventory_app [EXTRACTED 1.00]

## Communities (102 total, 7 thin omitted)

### Community 0 - "handlers.ts"
Cohesion: 0.12
Nodes (33): analysisRequest, P, pid(), projectOf(), sha, text, uuid, supplyReference() (+25 more)

### Community 1 - "BlobStore"
Cohesion: 0.23
Nodes (5): assertSafe(), blobKey(), stagingKey(), FsBlobStore, S3BlobStore

### Community 2 - "runtime.ts"
Cohesion: 0.16
Nodes (20): EnqueueInput, Job, LEASE_SECONDS, ReaAnalysisRunner, OriginalRunner, ReplacementRunner, buildHandler(), sha() (+12 more)

### Community 3 - "ContextPanel.tsx"
Cohesion: 0.31
Nodes (13): ContextPanel(), attachMedia(), onDrag(), useAttachment(), Props, accessAttachments(), addAttachments(), Attachment (+5 more)

### Community 4 - "Compare Engine"
Cohesion: 0.10
Nodes (31): compare(), compareBytes(), CompareResult, countChanged(), empty(), excerpt(), firstDifference(), globToRegExp() (+23 more)

### Community 5 - "codex-jobs.ts"
Cohesion: 0.18
Nodes (15): runtime, runtime, analysisStatus(), claimSchema, command, equal(), failureSchema, lease (+7 more)

### Community 6 - "Docker Compose Infra"
Cohesion: 0.07
Nodes (28): context, dockerfile, COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS, POSTGRES_DB, POSTGRES_PASSWORD, POSTGRES_USER, environment, image (+20 more)

### Community 7 - "Status Contracts"
Cohesion: 0.12
Nodes (21): AnalysisEligibility, ArtifactRole, ExecutionEligibility, JobKind, JobStatus, Role, image, ctx (+13 more)

### Community 8 - "Tar & Export Zip"
Cohesion: 0.14
Nodes (13): oct(), packTar(), pad(), unpackTar(), buildExport(), BuiltExport, bundleHarness(), j() (+5 more)

### Community 9 - "tsconfig Settings"
Cohesion: 0.11
Nodes (18): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+10 more)

### Community 10 - "Dev Dependencies"
Cohesion: 0.14
Nodes (14): devDependencies, @electric-sql/pglite@^0.5.16, fast-check@^4.10.2, tsx@^4.23.15, @types/node@^26.6.6, @types/pg@^8.23.1, @types/react@^19.3.0, vitest@^5.1.0 (+6 more)

### Community 11 - "Runtime Dependencies"
Cohesion: 0.15
Nodes (13): dependencies, @aws-sdk/client-s3@^3.1169.0, @aws-sdk/s3-request-presigner@^3.1169.0, esbuild@^0.28.2, next@^16.4.6, pg@^8.23.1, react@^19.3.1, react-dom@^19.3.1 (+5 more)

### Community 12 - "UI Screenshot Concepts"
Cohesion: 0.18
Nodes (11): Legacy Bridge Your Projects Screenshot, Add Project Button (blue circular plus), Banking tools card (Taxes and Stocks, 4 of 5 stages, edited 2 days ago), Billing portal card (Invoicing and payments, all 5 stages complete, edited 1 week ago), Download and Delete Card Actions, Legacy Bridge Header Bar, Question Mark Badge (orange, on Banking tools), Inventory app card (Stock and ordering, 2 of 5 stages, edited 3 hours ago) (+3 more)

### Community 13 - "wordfreq.c"
Cohesion: 0.06
Nodes (24): Commands and result shapes, F1 · REA and Ghidra feasibility, Inputs and method, Reproduce, Results, calculate(), main(), parse_input() (+16 more)

### Community 14 - "package.json Metadata"
Cohesion: 0.18
Nodes (10): author, bugs, url, description, homepage, keywords, license, name (+2 more)

### Community 15 - "scope.test.ts"
Cohesion: 0.09
Nodes (34): Db, Ctx, GenerationInput, createScopeRevision(), decideScope(), HEAD_COLUMNS, HeadName, Heads (+26 more)

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
Cohesion: 0.12
Nodes (34): metadata, RootLayout(), Page(), PrototypeResume(), ResumeProject(), Icon(), icons, Picker() (+26 more)

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
Cohesion: 0.11
Nodes (18): Isolation (read before touching runners or the worker image), COMPARE_ENGINE_VERSION, LIMITS, runCase(), RunOutcome, safeJoin(), sha(), Snap (+10 more)

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
Cohesion: 0.14
Nodes (23): buildReaAnalysisResult(), canonicalReaAddress(), evidenceAddress(), inventoryFindings(), normalizeReaEvidence(), object(), OPERATIONS, OperationStatus (+15 more)

### Community 54 - "s1-client.ts"
Cohesion: 0.12
Nodes (27): Layout(), ProjectLayout(), saveRaw(), Export(), download(), S1Home(), act(), create() (+19 more)

### Community 55 - "EvidencePanel.tsx"
Cohesion: 0.11
Nodes (28): active(), addressOf(), AnalysisRun, Candidate, Citation, EvidencePanel(), FindingDetail(), FindingDetails (+20 more)

### Community 56 - "s1.ts"
Cohesion: 0.20
Nodes (15): runtime, runtime, runtime, runtime, download, enabled(), s1Config(), s1Download() (+7 more)

### Community 57 - "StagePage"
Cohesion: 0.14
Nodes (16): Page(), Page(), Page(), Page(), Page(), AnalysisPanel(), S1Stage(), useOperation() (+8 more)

### Community 58 - "StageFrame.tsx"
Cohesion: 0.15
Nodes (27): indexArtifact(), requestPseudocode(), build(), Import(), probe(), upload(), Diagnostic, Modernize() (+19 more)

### Community 59 - "codex-worker.ts"
Cohesion: 0.23
Nodes (10): config(), Failure, Job, main(), processJob(), readEvidence(), run(), schema (+2 more)

### Community 60 - "api"
Cohesion: 0.14
Nodes (10): GET, runtime, dynamic, GET, runtime, GET, runtime, GET (+2 more)

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
Cohesion: 0.25
Nodes (6): all, benchmark(), dataSize(), operations, selected, suites

### Community 66 - "cases.ts"
Cohesion: 0.17
Nodes (25): canonical(), digest(), assertExecutionPermitted(), CaseSpec, createCaseSet(), createPolicy(), createTestCase(), requestCapture() (+17 more)

### Community 67 - "codex.ts"
Cohesion: 0.12
Nodes (18): moduleOutput, request, success, CodexGenerator, codexModuleSchema, Event, events(), ExecOptions (+10 more)

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

### Community 72 - "Select.tsx"
Cohesion: 0.15
Nodes (16): Detail, RevisionSummary, ScopeRevisions(), statusLabel, Draft, Select(), applyJson(), change() (+8 more)

### Community 73 - "run.ts"
Cohesion: 0.15
Nodes (13): pg, getApp(), db, dir, migrate(), createPgDb(), wrap(), main() (+5 more)

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

### Community 78 - "common.ts"
Cohesion: 0.26
Nodes (15): judge(), CaseInput, CaseSetEntry, captureHandler(), jobDir(), loadObservation(), stageSource(), storeObservation() (+7 more)

### Community 80 - "analysis.ts"
Cohesion: 0.16
Nodes (21): AnalysisRequest, evidenceBundle(), FINDING_KINDS, FindingKind, FindingRow, getFinding(), getRawEvidence(), listCandidates() (+13 more)

### Community 81 - "import-to-export.test.ts"
Cohesion: 0.16
Nodes (13): RFC-9562, uuidv7(), CONTROLS, ensureEnvironment(), EnvDef, createExport(), CASES, docker (+5 more)

### Community 82 - "generation.test.ts"
Cohesion: 0.12
Nodes (14): cancel(), call(), editor, fake, generate(), org, other, otherUser (+6 more)

### Community 83 - "queue.test.ts"
Cohesion: 0.18
Nodes (14): POST, runtime, generationWorkerCommand(), lost(), claim(), finish(), heartbeat(), retryOrFail() (+6 more)

### Community 84 - "ScopeEditor.tsx"
Cohesion: 0.24
Nodes (15): Evidence(), NoteList(), Props, replaceAt(), ScopeEditor(), short(), without(), BASES (+7 more)

### Community 85 - "codex-generation.ts"
Cohesion: 0.24
Nodes (11): zod, command, lease, noStore, Send, remoteFailureSchema, RemoteGenerationJob, remoteGenerationKind (+3 more)

### Community 86 - "ref_node_fs"
Cohesion: 0.23
Nodes (5): vitest, PresignedPut, docker, node(), RunRequest

### Community 87 - "analysis.test.ts"
Cohesion: 0.23
Nodes (12): analyze(), assertProvenance(), call(), Finding, findings(), Handler, ok(), outsider (+4 more)

### Community 89 - "api.test.ts"
Cohesion: 0.17
Nodes (9): setApp(), A, B, call(), ids, root, Who, buildElf() (+1 more)

### Community 90 - "generate.ts"
Cohesion: 0.30
Nodes (6): getModuleFiles(), putBlob(), buildEvidence(), GenerationOutputInvalid, validateGenerated(), generateHandler()

### Community 91 - "rea-analysis.test.ts"
Cohesion: 0.31
Nodes (9): addAddress, defaultSpaceAddress(), fixtureArtifactSha, ReaOperation, recording(), recordings, replayImageDigest, replayRea() (+1 more)

### Community 92 - "handler.ts"
Cohesion: 0.22
Nodes (9): Gotchas learned the hard way, authenticate(), pageLimit(), Principal, RANK, Role, route(), RouteArgs (+1 more)

### Community 93 - "ImportStage.tsx"
Cohesion: 0.33
Nodes (8): choosePrimary(), ImportStage(), onDrag(), selectFile(), detectExecutable(), ExecutableKind, notExecutableMessage, readExecutableKind()

### Community 94 - "Legacy Bridge"
Cohesion: 0.29
Nodes (6): Commands, Conventions, Invariants to keep (plan §4.4), Layout, Legacy Bridge, Repo etiquette

### Community 95 - "AnalysisPanel.tsx"
Cohesion: 0.47
Nodes (3): AnalysisResult, AnalysisStatus, MAX_ANALYSIS_BYTES

### Community 96 - "Legacy Bridge Codex handoff"
Cohesion: 0.33
Nodes (6): Current state, Legacy Bridge Codex handoff, Next run on the actual two laptops, Reproduce locally, What was verified, Where to start in the code

### Community 98 - "[rid]/route.ts"
Cohesion: 0.50
Nodes (3): dynamic, GET, runtime

## Ambiguous Edges - Review These
- `Question Mark Badge (orange, on Banking tools)` → `Five-step Progress Indicator`  [AMBIGUOUS]
  Screenshot 2026-11-14 105744.png · relation: conceptually_related_to

## Knowledge Gaps
- **10 isolated node(s):** `RFC-9562`, `RFC-9457`, `Add Project Button (blue circular plus)`, `Billing portal card (Invoicing and payments, all 5 stages complete, edited 1 week ago)`, `Download and Delete Card Actions` (+5 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 516 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `vitest` connect `ref_node_fs` to `codex.ts`, `Compare Engine`, `Status Contracts`, `Tar & Export Zip`, `Select.tsx`, `Dev Dependencies`, `package.json Metadata`, `scope.test.ts`, `import-to-export.test.ts`, `generation.test.ts`, `queue.test.ts`, `analysis.test.ts`, `BlobStore`, `api.test.ts`, `rea-analysis.test.ts`?**
  _High betweenness centrality (0.108) - this node is a cross-community bridge._
- **What connects `RFC-9562`, `RFC-9457`, `Add Project Button (blue circular plus)` to the rest of the system?**
  _10 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `handlers.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.12375533428165007 - nodes in this community are weakly interconnected._
- **Why does `Legacy Bridge — Backend Implementation Plan (with implementation status)` connect `Legacy Bridge — Backend Implementation Plan (with implementation status)` to `8. Security and operational requirements`, `BlobStore`, `CodeGenerator`, `12. Decisions and open questions`, `1. Backend scope and MVP boundary`, `2. Recommended architecture`, `4. State machines and invariants`, `10. Implementation sequence`, `6. Analysis and generation integration`, `wordfreq.c`, `9. Export contract`, `scope.test.ts`, `3. Domain model and persistence`, `7. Execution and verification design`?**
  _High betweenness centrality (0.083) - this node is a cross-community bridge._
- **Should `Compare Engine` be split into smaller, more focused modules?**
  _Cohesion score 0.09615384615384616 - nodes in this community are weakly interconnected._
- **Why does `react` connect `lib/projects.ts` to `ContextPanel.tsx`, `Select.tsx`, `Runtime Dependencies`, `package.json Metadata`, `ScopeEditor.tsx`, `s1-client.ts`, `EvidencePanel.tsx`, `StagePage`, `StageFrame.tsx`, `ImportStage.tsx`, `AnalysisPanel.tsx`?**
  _High betweenness centrality (0.076) - this node is a cross-community bridge._

### Low-confidence Hints
_AMBIGUOUS edges — the extractor was unsure. Verify before acting on these._

- **What is the exact relationship between `Question Mark Badge (orange, on Banking tools)` and `Five-step Progress Indicator`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._