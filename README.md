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

Built with Next.js (App Router) and React. Run `npm install`, then `npm run dev` and open http://localhost:3000. Projects, notes, and photo or video attachments are saved in that browser. The prototype walks through all five workflow steps and exports a project plan. Code modernization and automated verification require a backend.

## Backend (slice S1, in progress)

The UI is still the client-only prototype. The backend under `app/api/v1`, `server/`, `workers/` and `packages/` is built to
`~/.claude/plans/…purrfect-meteor.md` (Legacy Bridge — Backend Implementation Plan).

```
npm test                       # unit + API + e2e (e2e needs Docker and `make -C fixtures`; it skips with a reason otherwise)
npm run typecheck && npm run build
TEST_DATABASE_URL=postgres://lb:lb@localhost:5432/postgres npm test   # same suite on real PostgreSQL
S3_TEST_ENDPOINT=http://localhost:9090 npx vitest run tests/integration   # S3 store against an S3-compatible server
docker compose -f infra/docker-compose.yml up -d postgres s3 && DATABASE_URL=… npm run migrate
```

Known gaps (see the plan): isolation is plain Docker (runc), not gVisor, and `tsc` builds still run unsandboxed on the host (`LB_SANDBOX=direct`, refused in production), real login (S7), Ghidra/REA evidence (S2),
generation (S4), and the UI is not wired to the API. Original binaries and replacement modules run in hardened containers (no network, read-only rootfs, non-root, caps dropped).
