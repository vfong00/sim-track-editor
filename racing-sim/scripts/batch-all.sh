#!/bin/sh
# Batch every example scenario at once, one process each (the sim is single-threaded; a batch of
# five took ~30 min one after another and 8.5 min side by side on a 6-core Mac).
#   scripts/batch-all.sh [runs] [baseline-dir] [out-dir] [save-dir]
# With a baseline dir (e.g. baselines/phase-d): the scenarios it has baselines for, each compared
# against its own. Without: the five the phases measure. Runs from a snapshot of src/, so editing
# the code while it runs doesn't change the result.
set -e
cd "$(dirname "$0")/.."
RUNS=${1:-16}; BASE=${2:-}; OUT=${3:-$(mktemp -d)}; SAVE=${4:-}
mkdir -p "$OUT"
[ -n "$SAVE" ] && mkdir -p "$SAVE" && SAVE=$(cd "$SAVE" && pwd)
SNAP=$(mktemp -d)
cp -R src scenarios baselines package.json tsconfig.json "$SNAP"/ && ln -s "$PWD/node_modules" "$SNAP/node_modules"
if [ -n "$BASE" ]; then LIST=$(cd "$BASE" && ls *.json | sed 's/\.json$//')
else LIST="f1-constructors-monza f1-constructors-yas gt3-laguna-seca mx5-cup-laguna-seca safety-car-yas"; fi
for name in $LIST; do
  (cd "$SNAP" && npx tsx src/cli/sim.ts batch "scenarios/$name.json" --runs "$RUNS" ${BASE:+--baseline "$BASE/$name.json"} ${SAVE:+--save-to "$SAVE/$name.json"} > "$OUT/$name.txt" 2>&1) &
done
wait
rm -rf "$SNAP"
for f in "$OUT"/*.txt; do echo "== $(basename "$f" .txt)"; sed -n '/Per race/p;/Against/,$p' "$f"; done
echo "(full output in $OUT)"
