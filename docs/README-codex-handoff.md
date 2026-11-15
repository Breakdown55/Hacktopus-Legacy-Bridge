# Legacy Bridge Codex handoff

## Current state

Module generation and repair now use the signed-in Codex CLI. The Anthropic adapter and SDK were removed. This change builds on commit `5e49239`, which added the S3 scope workflow and S4 generation. Check `git status --short --branch` and `git log -5 --oneline` when resuming. At handoff, the implementation changes were staged locally.

The intended deployment has two machines. The hosting laptop runs Next.js, PostgreSQL, object storage, and `npm run worker`. The processing laptop runs `npm run worker:codex` with the user's Codex login. It polls the host over HTTPS using a worker key and returns structured TypeScript. The host validates, stores, and builds the module.

## Where to start in the code

| Path | Responsibility |
|---|---|
| [Modernize UI](../components/s1/Modernize.tsx) | **Generate TypeScript** and **Repair current module** enqueue work through `POST /api/v1/projects/{id}/module-revisions`. |
| [Generation request](../server/domain/generation.ts) and [host handler](../workers/handlers/generate.ts) | Check organization consent and approved scope. Assemble the request from the scope and cited evidence. Repair also includes prior files, build diagnostics, and optional instructions. |
| [Worker configuration](../workers/run.ts) and [remote adapter](../workers/generation/remote.ts) | `LB_GENERATION_PROVIDER=codex-remote` queues a leased processing job for the configured organization. `LB_GENERATION_PROVIDER=codex` invokes the CLI locally for development. |
| [Remote endpoint](../server/api/codex-generation.ts) and [processing worker](../workers/codex-worker.ts) | `POST /api/codex/generation` handles authenticated claims, heartbeats, and completion or failure. The worker checks in while the CLI runs. The optional static analysis demo has its own endpoint. |
| [Codex CLI adapter](../workers/generation/codex.ts) and [module persistence](../server/domain/modules.ts) | Use a temporary workspace and a strict JSON output schema. The host validates the result, checks the job lease, current scope, and consent, then publishes the revision and queues its build. |

## What was verified

- The live synthetic smoke ran **both processes on the same Windows laptop** over loopback HTTP. A separate worker process used the real signed-in Codex CLI. The returned word-count module built and ran in Docker, matching `3\n` for whitespace-separated input and `0\n` for empty input.
- Targeted tests covered worker authentication, stale leases, cancellation, revoked consent, malformed output, and repair context. The full suite passed **134 tests** with one POSIX-only test skipped on Windows. Type checking and the production build passed.
- Your friend's machine, its domain, and HTTPS routing between the two physical laptops remain to be tested. Generation quality on the stripped `intcalc` fixture also remains open.

## Reproduce locally

```powershell
npm run typecheck
npm test -- tests/unit/codex-generator.test.ts tests/api/generation.test.ts tests/api/codex-jobs.test.ts
```

For the live synthetic smoke, start Docker with the pinned replacement image from the [S1 setup](../README.md#s1-browser-workflow), check `codex login status`, then run:

```powershell
$env:LB_TEST_LIVE_CODEX = '1'
npm test -- tests/api/generation.test.ts
```

## Next run on the actual two laptops

1. Follow the [two-laptop setup](../README.md#private-demo-on-two-laptops). On the host, migrate the database and use the same organization ID for `LB_CODEX_ORG_ID` and the project workflow. Enable `external_model_allowed` for that organization. Start the main worker with `LB_GENERATION_PROVIDER=codex-remote`.
2. Serve `/api/codex/generation` on the host over HTTPS. Set the same `LB_CODEX_WORKER_KEY` on both machines. Keep the worker key out of browser code and use a separate key if enabling the optional static analysis demo.
3. On the processing laptop, point `LB_SITE_URL` at the host's HTTPS origin, confirm the CLI login, and run `npm run worker:codex`. Use a small synthetic project for the first run.
4. Open the host's full workflow UI through loopback or an SSH local port forward. Approve a scope on **Select**, click **Generate TypeScript** on **Modernize**, and confirm that the processing laptop claims the job and the host shows a new built revision. Try repair and confirm that a second revision links to its parent. The full workflow UI still depends on development authentication. The production build exposes the authenticated worker endpoint.
