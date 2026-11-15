These four JSON files are stdout captured from REA 6.9.0 with Ghidra 12.1 in
the F1 analysis image. The target was the stripped x86-64 ELF built from
`fixtures/src/wordfreq.c` by `infra/images/analysis/f1-fixtures.sh`. Each
envelope is preserved as captured. The xrefs and pseudocode target the `add`
function at `ram:0x401286` in the unstripped symbol oracle.

The unit tests replay these outputs without Docker. The live test uses the
newly built target, its matching unstripped `wordfreq.symbols` oracle, and an
explicitly supplied local analysis image ID. See `docs/f1-analysis-spike.md`
for the collection commands.

After building the analysis image and F1 executable fixtures, run the live test
from the repository root in PowerShell:

```powershell
$env:LB_S2_TEST_IMAGE = (docker image inspect --format '{{.Id}}' lb-analysis:f1).Trim()
npm.cmd test -- tests/api/analysis.test.ts
```

If Docker is outside `PATH`, set `DOCKER_BIN` to the Docker executable path
and call that executable in the inspect command. Set `LB_S2_TEST_RUNTIME=runsc`
if the Docker engine has the gVisor runtime registered.
