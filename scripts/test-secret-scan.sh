#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
config="${1:-$repo_root/.gitleaks.toml}"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/penumbra-secret-scan.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/ignore"
touch "$scratch/ignore/.gitleaksignore"

scan_dir() {
  scan_exit=0
  gitleaks dir "$scratch/fixture" --config="$config" --redact=100 \
    --ignore-gitleaks-allow --gitleaks-ignore-path="$scratch/ignore/.gitleaksignore" \
    --no-banner --report-format=json --report-path="$scratch/report.json" \
    > "$scratch/scanner.log" 2>&1 || scan_exit=$?
}

expect_detected() {
  local rule="${2:-github-pat}"
  if [ "$scan_exit" -ne 1 ] || [ ! -f "$scratch/report.json" ] || \
    ! grep -Fq "\"RuleID\": \"$rule\"" "$scratch/report.json"; then
    echo "FAIL: $1 must be detected by $rule" >&2
    cat "$scratch/scanner.log" >&2
    exit 1
  fi
  echo "PASS: $1"
}

fixture_file() {
  rm -rf "$scratch/fixture"
  mkdir -p "$scratch/fixture/$(dirname "$1")"
  fixture="$scratch/fixture/$1"
}

# Assemble an inert positive control so the self-test does not resemble a leak.
sentinel=$(printf '%s%s' 'ghp_' '5z7Kp3Ld9Qx2Vm8Ns6Bc4Rf0Tj1Ha9Yu8We2')
for path in credentials.txt scripts/fetch-embedder-model.ts \
  packages/agentchat/test/adapters/stdio-acp-write.test.ts \
  docs/superpowers/plans/2026-05-24-antigravity-acp-bridge-plan.md; do
  fixture_file "$path"
  printf 'token = "%s"\n' "$sentinel" > "$fixture"
  scan_dir
  expect_detected "credential in $path"
done

fixture_file credentials.txt
printf 'token = "%s" # gitleaks:allow\n' "$sentinel" > "$fixture"
scan_dir
expect_detected 'inline comments cannot bypass the scan'

fixture_file scripts/fetch-embedder-model.ts
printf '"tokenizer.json": "%s"\n' \
  'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0' > "$fixture"
scan_dir
if [ "$scan_exit" -ne 0 ]; then
  echo 'FAIL: the reviewed model checksum must be accepted' >&2
  cat "$scratch/scanner.log" >&2
  exit 1
fi
echo 'PASS: reviewed model checksum'

fixture_file credentials.txt
printf 'token = "%s"\n' \
  'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0' > "$fixture"
scan_dir
expect_detected 'checksum exception does not apply to another file' generic-api-key

fixture_file credentials.txt
printf 'token = "%s"\n' "$sentinel" > "$fixture"
git -C "$scratch/fixture" init -q
git -C "$scratch/fixture" add credentials.txt
git -C "$scratch/fixture" -c user.name='Secret scan fixture' \
  -c user.email=fixture@example.invalid -c commit.gpgsign=false \
  -c core.hooksPath=/dev/null commit -qm 'Add fixture'
git -C "$scratch/fixture" rm -q credentials.txt
git -C "$scratch/fixture" -c user.name='Secret scan fixture' \
  -c user.email=fixture@example.invalid -c commit.gpgsign=false \
  -c core.hooksPath=/dev/null commit -qm 'Remove fixture'
scan_exit=0
gitleaks git "$scratch/fixture" --log-opts=--all --config="$config" --redact=100 \
  --ignore-gitleaks-allow --gitleaks-ignore-path="$scratch/ignore/.gitleaksignore" \
  --no-banner --report-format=json --report-path="$scratch/report.json" \
  > "$scratch/scanner.log" 2>&1 || scan_exit=$?
expect_detected 'credential removed from the working tree but retained in history'
