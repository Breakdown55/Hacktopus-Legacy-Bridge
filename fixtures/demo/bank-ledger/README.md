# Bank Ledger demo recording

With `LB_DEMO_REPLAY=1` (development worker only), a project named **Bank Ledger** whose uploaded executable is exactly
`bankledger.stripped` from this folder replays the results below after a short wait, instead of running Ghidra and the model again.
Everything else runs for real: findings are normalized and stored, the code is validated and built, and Verify runs both programs.
Replayed module versions are stored with provider `recording`.

Recorded on 2026-11-15 on macOS (Docker runc, emulated amd64) from one real run through the app:

- `rea/`: raw output of the four REA 6.9.0 / Ghidra 12.1 container operations for `bankledger.stripped`.
- `recording.json` `names`: the function names Codex suggested, one call per function.
- `recording.json` `generation.first`: the first Codex generation (single call). It built, and asked one question.
- `recording.json` `generation.resolved`: the regeneration after that question was answered and `bankledger-input.txt` was attached.

The live UI generates feature by feature; the recording is of single-call generations, replayed once per feature for the progress list.
`bankledger-input.txt` and `bankledger-output.txt` are an example batch and what the original program prints for it.
Source of the program: `fixtures/drafts/bankledger.c` (gcc 13, -O1, stripped).
