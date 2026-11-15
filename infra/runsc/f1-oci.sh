#!/bin/sh
# Run as root on a Linux host with systemd and cgroup v2. See docs/f1-analysis-spike.md.
set -eu
if [ "$#" -lt 5 ]; then
    echo 'usage: f1-oci.sh RUNSC IMAGE_TAR FIXTURES SPEC RESULTS [FIXTURE...]' >&2
    exit 2
fi
runsc=$(realpath "$1")
archive=$(realpath "$2")
fixtures=$(realpath "$3")
spec=$(realpath "$4")
results=$(realpath "$5")
shift 5
bundle=$(mktemp -d /var/tmp/lb-f1-oci.XXXXXX)
chmod 755 "$bundle"
printf 'bundle=%s\n' "$bundle"
mkdir "$bundle/rootfs"
tar -xf "$archive" -C "$bundle/rootfs"
cd "$bundle"
"$runsc" spec
python3 - "$fixtures" "$spec" "$results" "$@" <<'PY'
import json
from pathlib import Path
import sys

file = Path("config.json")
config = json.loads(file.read_text())
config["root"]["readonly"] = True
config["hostname"] = "lb-analysis"
config["process"].update({
    "terminal": False,
    "cwd": "/tmp",
    "user": {"uid": 1000, "gid": 1000},
    "args": ["/usr/local/bin/node", "/spec/f1-runner.mjs", *sys.argv[4:]],
    "env": [
        "PATH=/opt/java/openjdk/bin:/usr/local/bin:/usr/bin:/bin",
        "JAVA_HOME=/opt/java/openjdk",
        "GHIDRA_INSTALL_DIR=/opt/ghidra_12.1_PUBLIC",
        "HOME=/tmp/lb-analysis",
        "JAVA_TOOL_OPTIONS=-XX:ActiveProcessorCount=4",
    ],
    "noNewPrivileges": True,
    "capabilities": {name: [] for name in ("bounding", "effective", "inheritable", "permitted", "ambient")},
})
config["mounts"].append({
    "destination": "/tmp", "type": "tmpfs", "source": "tmpfs",
    "options": ["nosuid", "nodev", "mode=1777", "size=1073741824"],
})
for source, destination, mode in zip(sys.argv[1:4], ("/fixtures", "/spec", "/results"), ("ro", "ro", "rw")):
    config["mounts"].append({
        "destination": destination, "type": "bind", "source": source,
        "options": ["rbind", mode, "nosuid", "nodev", "noexec"],
    })
file.write_text(json.dumps(config, indent=2) + "\n")
PY
systemd-run --scope --quiet --expand-environment=no -p MemoryMax=8G -p MemorySwapMax=0 -- sh -c '
  set +e
  "$1" --root "$2/runsc-state" --platform=systrap --network=none --ignore-cgroups run --bundle "$2" lb-analysis-f1
  status=$?
  group=$(sed -n "s/^0:://p" /proc/self/cgroup)
  printf "host_memory_max_bytes="; cat "/sys/fs/cgroup${group}/memory.max"
  printf "host_memory_peak_bytes="; cat "/sys/fs/cgroup${group}/memory.peak"
  exit "$status"
' sh "$runsc" "$bundle"
