#!/usr/bin/env bash
# Pull the latest reference factory into templates/ and docs/upstream/.
# Usage: scripts/sync-upstream.sh [git-ref]   (default: main)
# Review `git diff` afterwards, bump the package version, and publish.
set -euo pipefail

REF="${1:-main}"
REPO=https://github.com/zazencodes/zazencodes-season-3.git
SUB=src/software-factory-claude-code-v2
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git clone --quiet --filter=blob:none --no-checkout "$REPO" "$TMP/repo"
git -C "$TMP/repo" sparse-checkout set "$SUB"
git -C "$TMP/repo" checkout --quiet "$REF"
SHA="$(git -C "$TMP/repo" rev-parse HEAD)"
SRC="$TMP/repo/$SUB"

FILES=(
  .claude/skills/factory/SKILL.md
  .claude/agents/intake.md .claude/agents/spec-writer.md .claude/agents/builder.md
  .claude/agents/reviewer-code.md .claude/agents/reviewer-security.md
  .claude/agents/reviewer-ux.md .claude/agents/reviewer-ui.md .claude/agents/approver.md
  factory/config.json factory/checks.sh factory/bin/job factory/bin/gate factory/bin/route
  factory/dashboard.html
)
for f in "${FILES[@]}"; do
  mkdir -p "$ROOT/templates/$(dirname "$f")"
  cp "$SRC/$f" "$ROOT/templates/$f"
done
chmod +x "$ROOT/templates/factory/checks.sh" "$ROOT"/templates/factory/bin/*

# Re-apply this package's changes to upstream files (e.g. /factory dashboard).
for p in "$ROOT"/scripts/patches/*.patch; do
  [ -e "$p" ] || continue
  if git -C "$ROOT" apply "$p"; then echo "applied $(basename "$p")"
  else echo "FAILED to apply $(basename "$p"): redo it by hand, then regenerate the patch" >&2; fi
done
cp "$SRC/INSTALL.md" "$SRC/DESIGN.md" "$ROOT/docs/upstream/"
cp "$SRC/LICENSE" "$ROOT/LICENSE"

node -e '
const fs = require("fs"); const p = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(p, "utf8"));
pkg.agentFactory.upstream = `https://github.com/zazencodes/zazencodes-season-3/tree/${process.argv[2]}/src/software-factory-claude-code-v2`;
fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + "\n");
' "$ROOT/package.json" "$SHA"

echo "Synced templates from $SHA. If INSTALL.md changed, update templates/.claude/skills/factory-setup/SKILL.md to match."
git -C "$ROOT" status --short
