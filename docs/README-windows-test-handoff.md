# Legacy Bridge Windows TEST handoff

## Windows

Open [Windows TEST](http://127.0.0.1:3100). The header shows **TEST**. This instance uses its own local PostgreSQL database (`legacy_bridge_windows_test`) and S3Mock bucket (`legacy-bridge-windows-test`). The Windows worker runs REA/Ghidra, invokes the signed-in local Codex CLI, and builds the selected target.

The [local backend setup](../README.md#s1-browser-workflow) documents how to restart the service. Use these settings in the respective Windows shells:

```powershell
# Next.js development server
$env:NEXT_PUBLIC_LB_MACHINE_PROFILE = 'TEST'
$env:NEXT_PUBLIC_LB_S1_UI = '1'
$env:LB_DEV_AUTH = '1'
npm run dev -- --hostname 127.0.0.1 --port 3100
```

```powershell
# Windows worker, with the same database and storage settings
$env:LB_GENERATION_PROVIDER = 'codex'
$env:LB_SANDBOX = 'direct'
npm run worker
```

The TypeScript compiler runs on the Windows host in this local workflow. Python, Go, Java, and C# builds use their pinned Docker images.

The [Go smoke project](http://127.0.0.1:3100/projects/01a1de7e-4e2c-7783-921f-1edc0bc988d8/export) is ready in the Windows test database. Chrome checked the five target choices, imported stripped `intcalc`, and generated Go with the local Codex worker. The original and replacement matched on the smoke case. The downloaded ZIP passed the integrity check and replayed the match in Docker.

## Switch the Mac handoff to PROD

On the Mac, set the profile in the shell or service environment that already starts Legacy Bridge:

```bash
export NEXT_PUBLIC_LB_MACHINE_PROFILE=PROD
```

Restart the existing dev server, or rebuild and restart if it uses `npm start`. Check the **PROD** badge on the app. This setting controls the visible machine label. Keep the Mac’s existing startup command, backend flags, database, and Codex settings.
