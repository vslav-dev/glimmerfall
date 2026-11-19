#!/usr/bin/env bash
# Offline move analysis from production telemetry (plans/06):
#  1. fetches every `attempt` event from the ingest (read-only on the server);
#  2. replays each on the game code that played it: one temporary worktree per rules version,
#     src/tools/replay-dump.test.ts dumps every calm-board move with the board the player saw;
#  3. checks the player model on the current code: src/tools/model-check.test.ts prints the population
#     fit (PRIOR / SCALE for player/model.ts), learning quality and twin calibration.
# Usage: tools/analyze.sh [work dir]    (default: a fresh temp dir; dumps stay there)
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
WORK=${1:-$(mktemp -d)}
mkdir -p "$WORK"
echo "📂 $WORK"

ssh vps-31 'cat /root/megaback/data/ingest/glimmerfall/*.ndjson' > "$WORK/all.ndjson"

# One input file per rules version: the game code a replay must run on.
node - "$WORK" <<'JS'
const fs = require('node:fs');
const work = process.argv[2];
const groups = new Map();
for (const line of fs.readFileSync(`${work}/all.ndjson`, 'utf8').split('\n')) {
  if (!line.startsWith('{')) continue;
  const e = JSON.parse(line);
  if (e.stream !== 'attempt') continue;
  const rules = e.data.rules ?? e.data.gen;
  if (!groups.has(rules)) groups.set(rules, []);
  groups.get(rules).push(e.data);
}
for (const [rules, events] of groups) fs.writeFileSync(`${work}/in${rules}.json`, JSON.stringify(events));
console.log(`📡 ${[...groups].map(([r, e]) => `rules ${r}: ${e.length}`).join(', ')}`);
JS

for input in "$WORK"/in*.json; do
  rules=$(basename "$input" .json | tr -dc '0-9')
  # The commit that introduced this version: later commits of the same version play alike.
  commits=$(git -C "$ROOT" log --reverse --format=%h -S "GEN_VERSION = $rules;" -- src/gen/generator.ts)
  commit=${commits%%$'\n'*}
  if [ -z "$commit" ]; then echo "⚠️ no commit for rules $rules"; continue; fi
  tree="$WORK/tree$rules"
  git -C "$ROOT" worktree add -q --detach "$tree" "$commit"
  ln -s "$ROOT/node_modules" "$tree/node_modules"
  mkdir -p "$tree/src/tools"
  cp "$ROOT/src/tools/replay-dump.test.ts" "$tree/src/tools/"
  (cd "$tree" && GF_IN="$input" GF_OUT="$WORK/dump$rules.json" npx vitest run src/tools/replay-dump.test.ts > /dev/null) || echo "⚠️ replay failed for rules $rules"
  git -C "$ROOT" worktree remove --force "$tree"
  echo "🔁 rules $rules replayed on $commit"
done

cd "$ROOT" && GF_DUMPS="$WORK" npx vitest run src/tools/model-check.test.ts --silent=false 2>&1 | grep -E '📊|📐|🔁|🎯|🧠'
