#!/bin/sh
# Run in the pinned GCC image with the repository fixtures mounted at /f.
set -eu
cd /f
mkdir -p bin/f1
for fixture in wordfreq intcalc rand; do
    case "$fixture" in
        wordfreq) anchor=add ;;
        intcalc) anchor=calculate ;;
        rand) anchor=read_random ;;
    esac
    out="bin/f1/$fixture"
    # Fixed ELF load addresses allow the same oracle to select procedures in both variants.
    gcc -O0 -fno-inline -fno-pie -no-pie -o "$out" "src/$fixture.c"
    nm --defined-only "$out" | awk -v name="$anchor" '$3 == name { sub(/^0+/, "", $1); print "ram:0x" $1 }' > "$out.address"
    test -s "$out.address"
    nm --defined-only "$out" | awk '$2 ~ /^[tT]$/ { sub(/^0+/, "", $1); print $1, $3 }' > "$out.symbols"
    strip -o "$out.stripped" "$out"
    readelf -h "$out.stripped" | grep 'Advanced Micro Devices X86-64'
done
