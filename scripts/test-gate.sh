#!/usr/bin/env bash
# =============================================================================
# scripts/test-gate.sh — Wave-level regression gate for the test suite.
#
# USAGE
#   bash scripts/test-gate.sh [MODE] [ARGS...]
#
# MODES
#   full                Run the canonical full suite and assert 0 fail / 0 error
#                       / 0 "Unhandled error between tests".
#
#   solo [file...]      Run each FILE as a standalone bun test and report
#                       pass/fail.  If no files are given, uses the files
#                       changed vs HEAD (git diff --name-only HEAD) that match
#                       *.test.ts or *.test.tsx.
#
#   compare             Run both full and solo (changed files) and flag
#                       isolation violations: solo passes but full fails for
#                       the same file, or full passes but solo fails.
#
#   shuffle [seed]      Shuffle all test files using SEED (default: epoch seconds)
#                       and run them in that order.  Logs the ordered file list
#                       to /tmp for reproducibility.  Asserts 0 fail / 0 error.
#
#   coverage            Run bun test --coverage and compare the % Lines column
#                       per file against tests/.coverage-baseline.txt.
#                       If any tracked file's coverage drops below the baseline
#                       value, prints "COVERAGE REGRESSION" and exits 1.
#                       If the baseline file is missing, prints guidance.
#
#   baseline-freeze     Capture the current coverage report and write it to
#                       tests/.coverage-baseline.txt (overwriting any existing
#                       baseline).  Run this once after the clean W0 state and
#                       intentionally after coverage-improving waves.
#
# DEPENDENCIES
#   bun (>=1.3), git, awk, shuf (GNU coreutils — install via homebrew on macOS)
#
# COMPATIBILITY
#   Written for bash 3.2+ (macOS default).  No mapfile/readarray used.
#
# READ-ONLY GUARANTEE
#   This script only reads state (runs tests, reads git, reads files).
#   It never modifies source files or test files.
#   baseline-freeze writes only tests/.coverage-baseline.txt.
#
# EXIT CODES
#   0  All assertions passed
#   1  One or more assertions failed (details printed to stdout)
#   2  Usage error / missing dependency
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Paths (resolve relative to the repo root regardless of CWD)
# ---------------------------------------------------------------------------
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE_FILE="${REPO_ROOT}/tests/.coverage-baseline.txt"
TEST_DIRS="tests/unit tests/integration"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

die() { echo "ERROR: $*" >&2; exit 2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not found in PATH"
}

# read_lines_into_array VAR CMD...
# Portable bash-3 replacement for:  mapfile -t VAR < <(CMD...)
# Usage: read_lines_into_array myarr find . -name '*.ts'
read_lines_into_array() {
  local _var="$1"; shift
  local _tmpfile
  _tmpfile=$(mktemp)
  "$@" > "$_tmpfile" 2>/dev/null || true
  local _i=0
  local _line
  while IFS= read -r _line; do
    eval "${_var}[${_i}]=\"\${_line}\""
    _i=$(( _i + 1 ))
  done < "$_tmpfile"
  rm -f "$_tmpfile"
}

# Parse bun test summary output and extract key counters.
# Prints: "FAIL=N ERROR=N UNHANDLED=N"
parse_bun_summary() {
  local output="$1"
  local fail_count=0 error_count=0 unhandled_count=0

  # " N fail" — leading whitespace, then digit(s), then " fail" at end of line
  if echo "$output" | grep -qE '^\s+[0-9]+ fail$'; then
    fail_count=$(echo "$output" | grep -E '^\s+[0-9]+ fail$' | tail -1 | tr -dc '0-9')
  fi

  # " N error" — separate summary line emitted for module-level crashes
  if echo "$output" | grep -qE '^\s+[0-9]+ error$'; then
    error_count=$(echo "$output" | grep -E '^\s+[0-9]+ error$' | tail -1 | tr -dc '0-9')
  fi

  # "Unhandled error between tests" — count occurrences
  unhandled_count=$(echo "$output" | grep -c "Unhandled error between tests" || true)

  echo "FAIL=${fail_count} ERROR=${error_count} UNHANDLED=${unhandled_count}"
}

# Return 0 when all three counters are zero, 1 otherwise.
assert_clean() {
  local summary="$1" label="${2:-}"
  local fail error unhandled
  fail=$(echo "$summary"      | grep -oE 'FAIL=[0-9]+'     | cut -d= -f2)
  error=$(echo "$summary"     | grep -oE 'ERROR=[0-9]+'    | cut -d= -f2)
  unhandled=$(echo "$summary" | grep -oE 'UNHANDLED=[0-9]+' | cut -d= -f2)

  if [ "${fail:-0}" -eq 0 ] && [ "${error:-0}" -eq 0 ] && [ "${unhandled:-0}" -eq 0 ]; then
    echo "  PASS  fail=0 error=0 unhandled=0${label:+  [${label}]}"
    return 0
  else
    echo "  FAIL  fail=${fail:-0} error=${error:-0} unhandled=${unhandled:-0}${label:+  [${label}]}"
    return 1
  fi
}

# Coverage table parser: stdin = bun --coverage output.
# Output format: "filename<TAB>%lines" per line, one entry per source file.
# "All files" aggregate row is normalised to key "ALL_FILES".
parse_coverage_table() {
  grep -E "^ (src|tests)/|^All files" | \
  while IFS='|' read -r name _funcs lines _rest; do
    local name_t lines_t
    # Strip all whitespace from name and lines columns
    name_t=$(echo "$name"  | tr -d ' ')
    lines_t=$(echo "$lines" | tr -d ' ')
    [ -z "$name_t" ] && continue
    [ -z "$lines_t" ] && continue
    # "All files" has its spaces removed → "Allfiles"; normalise
    [ "$name_t" = "Allfiles" ] && name_t="ALL_FILES"
    printf '%s\t%s\n' "$name_t" "$lines_t"
  done
}

# ---------------------------------------------------------------------------
# MODE: full
# ---------------------------------------------------------------------------
mode_full() {
  echo "=== test-gate: full ==="
  cd "${REPO_ROOT}"
  local output
  # shellcheck disable=SC2086
  output=$(bun test ${TEST_DIRS} 2>&1)
  echo "$output"
  echo "--- summary ---"
  local summary
  summary=$(parse_bun_summary "$output")
  assert_clean "$summary" "full suite"
}

# ---------------------------------------------------------------------------
# MODE: solo
# ---------------------------------------------------------------------------
mode_solo() {
  local overall_rc=0

  if [ "$#" -gt 0 ]; then
    echo "=== test-gate: solo (explicit files) ==="
    local files=("$@")
  else
    echo "=== test-gate: solo (changed files from git diff HEAD) ==="
    cd "${REPO_ROOT}"
    local files=()
    while IFS= read -r line; do
      case "$line" in *.test.ts|*.test.tsx) files+=("$line") ;; esac
    done < <(git diff --name-only HEAD 2>/dev/null || true)
    if [ "${#files[@]}" -eq 0 ]; then
      echo "  No changed test files detected."
      return 0
    fi
  fi

  local f
  for f in "${files[@]}"; do
    local abs_f
    abs_f="${REPO_ROOT}/${f}"
    # If the caller passed an absolute path, use it directly
    case "$f" in /*) abs_f="$f" ;; esac
    if [ ! -f "$abs_f" ]; then
      echo "  SKIP  (not found) $f"
      continue
    fi
    local out
    out=$(bun test "$abs_f" 2>&1) || true
    local summary
    summary=$(parse_bun_summary "$out")
    assert_clean "$summary" "$f" || overall_rc=1
  done
  return $overall_rc
}

# ---------------------------------------------------------------------------
# MODE: compare
# ---------------------------------------------------------------------------
mode_compare() {
  echo "=== test-gate: compare ==="
  cd "${REPO_ROOT}"

  # Collect changed test files
  local changed=()
  while IFS= read -r line; do
    case "$line" in *.test.ts|*.test.tsx) changed+=("$line") ;; esac
  done < <(git diff --name-only HEAD 2>/dev/null || true)

  if [ "${#changed[@]}" -eq 0 ]; then
    echo "  No changed test files — running full only."
    mode_full
    return $?
  fi

  # --- Full suite ---
  echo "--- Running full suite ---"
  local full_out
  # shellcheck disable=SC2086
  full_out=$(bun test ${TEST_DIRS} 2>&1) || true
  local full_summary
  full_summary=$(parse_bun_summary "$full_out")
  local full_fail full_error full_unhandled
  full_fail=$(echo "$full_summary"      | grep -oE 'FAIL=[0-9]+'     | cut -d= -f2)
  full_error=$(echo "$full_summary"     | grep -oE 'ERROR=[0-9]+'    | cut -d= -f2)
  full_unhandled=$(echo "$full_summary" | grep -oE 'UNHANDLED=[0-9]+' | cut -d= -f2)
  local full_clean=true
  if [ "${full_fail:-0}" -gt 0 ] || [ "${full_error:-0}" -gt 0 ] || [ "${full_unhandled:-0}" -gt 0 ]; then
    full_clean=false
  fi
  echo "  Full: fail=${full_fail:-0} error=${full_error:-0} unhandled=${full_unhandled:-0}"

  # --- Solo for each changed file ---
  echo "--- Running solo for changed files ---"
  local overall_rc=0
  local f
  for f in "${changed[@]}"; do
    local abs_f="${REPO_ROOT}/${f}"
    case "$f" in /*) abs_f="$f" ;; esac
    [ -f "$abs_f" ] || continue

    local solo_out
    solo_out=$(bun test "$abs_f" 2>&1) || true
    local solo_summary
    solo_summary=$(parse_bun_summary "$solo_out")
    local solo_fail solo_error
    solo_fail=$(echo "$solo_summary"  | grep -oE 'FAIL=[0-9]+'  | cut -d= -f2)
    solo_error=$(echo "$solo_summary" | grep -oE 'ERROR=[0-9]+' | cut -d= -f2)
    local solo_clean=true
    if [ "${solo_fail:-0}" -gt 0 ] || [ "${solo_error:-0}" -gt 0 ]; then
      solo_clean=false
    fi

    if $solo_clean && ! $full_clean; then
      echo "  ISOLATION VIOLATION: ${f}  (solo=PASS, full=FAIL)"
      echo "    → File passes alone but the full suite fails — likely cross-file pollution."
      overall_rc=1
    elif ! $solo_clean && $full_clean; then
      echo "  ISOLATION VIOLATION: ${f}  (solo=FAIL, full=PASS)"
      echo "    → File fails alone but passes in the full suite — likely order dependency."
      overall_rc=1
    elif $solo_clean && $full_clean; then
      echo "  OK  ${f}"
    else
      echo "  FAIL (both solo and full)  ${f}"
      overall_rc=1
    fi
  done

  if [ "$overall_rc" -eq 0 ]; then
    echo "=== compare: PASSED — no isolation violations ==="
  else
    echo "=== compare: FAILED — isolation violations detected ==="
  fi
  return $overall_rc
}

# ---------------------------------------------------------------------------
# MODE: shuffle
# ---------------------------------------------------------------------------
mode_shuffle() {
  local seed="${1:-$SECONDS}"
  echo "=== test-gate: shuffle (seed=${seed}) ==="
  cd "${REPO_ROOT}"

  require_cmd shuf

  # Collect all test files
  local all_files=()
  while IFS= read -r line; do
    all_files+=("$line")
  done < <(
    find tests/unit tests/integration \
      \( -name '*.test.ts' -o -name '*.test.tsx' \) \
      2>/dev/null | sort
  )

  if [ "${#all_files[@]}" -eq 0 ]; then
    die "No test files found under tests/unit and tests/integration"
  fi

  # Deterministic shuffle via awk Fisher-Yates with seed
  # (shuf doesn't support a seed flag portably; awk does via srand)
  local shuffled_list
  shuffled_list=$(
    printf '%s\n' "${all_files[@]}" | \
    awk -v seed="$seed" '
      BEGIN { srand(seed) }
      { lines[NR] = $0 }
      END {
        for (i = NR; i > 1; i--) {
          j = int(rand() * i) + 1
          t = lines[i]; lines[i] = lines[j]; lines[j] = t
        }
        for (i = 1; i <= NR; i++) print lines[i]
      }
    '
  )

  # Log the order for reproducibility
  local order_log="/tmp/test-gate-shuffle-seed${seed}-$(date +%Y%m%dT%H%M%S).txt"
  echo "$shuffled_list" > "$order_log"
  local file_count
  file_count=$(echo "$shuffled_list" | wc -l | tr -d ' ')
  echo "  File order logged to: ${order_log}"
  echo "  Total files: ${file_count}"
  echo "  Reproduce with: bash scripts/test-gate.sh shuffle ${seed}"

  # Run tests in shuffled order via xargs
  local output
  output=$(echo "$shuffled_list" | xargs bun test 2>&1)
  echo "$output"
  echo "--- summary ---"

  local summary
  summary=$(parse_bun_summary "$output")
  assert_clean "$summary" "shuffle seed=${seed}"
}

# ---------------------------------------------------------------------------
# MODE: coverage
# ---------------------------------------------------------------------------
mode_coverage() {
  echo "=== test-gate: coverage ==="
  cd "${REPO_ROOT}"

  if [ ! -f "$BASELINE_FILE" ]; then
    echo "  BASELINE MISSING: ${BASELINE_FILE}"
    echo "  Run 'bash scripts/test-gate.sh baseline-freeze' to create it."
    return 1
  fi

  echo "  Running bun test --coverage …"
  local cov_out
  # shellcheck disable=SC2086
  cov_out=$(bun test --coverage ${TEST_DIRS} 2>&1)

  # Parse current coverage into a temp file for fast lookup
  local cur_tmp
  cur_tmp=$(mktemp)
  echo "$cov_out" | parse_coverage_table > "$cur_tmp"

  echo "  Comparing against baseline: ${BASELINE_FILE}"
  local regression_found=false

  while IFS=$'\t' read -r bfile blines; do
    [ -z "$bfile" ] && continue

    # Look up current value for this file
    local cur_lines
    cur_lines=$(awk -F$'\t' -v f="$bfile" '$1==f {print $2}' "$cur_tmp")

    if [ -z "$cur_lines" ]; then
      echo "  COVERAGE REGRESSION: ${bfile}  (baseline=${blines}%, current=missing)"
      regression_found=true
      continue
    fi

    # Float comparison via awk (bash arithmetic can't handle decimals)
    local is_regression
    is_regression=$(awk -v cur="$cur_lines" -v base="$blines" \
      'BEGIN { print (cur + 0 < base + 0) ? "yes" : "no" }')
    if [ "$is_regression" = "yes" ]; then
      echo "  COVERAGE REGRESSION: ${bfile}  (baseline=${blines}%, current=${cur_lines}%)"
      regression_found=true
    fi
  done < "$BASELINE_FILE"

  rm -f "$cur_tmp"

  # Print aggregate summary
  local cur_agg base_agg
  cur_agg=$(echo "$cov_out" | parse_coverage_table | awk -F$'\t' '$1=="ALL_FILES" {print $2}')
  base_agg=$(awk -F$'\t' '$1=="ALL_FILES" {print $2}' "$BASELINE_FILE")
  echo "  Aggregate % Lines (current):  ${cur_agg:-N/A}%"
  echo "  Aggregate % Lines (baseline): ${base_agg:-N/A}%"

  if $regression_found; then
    echo "=== coverage: FAILED — regressions detected ==="
    return 1
  else
    echo "=== coverage: PASSED — no regressions vs baseline ==="
    return 0
  fi
}

# ---------------------------------------------------------------------------
# MODE: baseline-freeze
# ---------------------------------------------------------------------------
mode_baseline_freeze() {
  echo "=== test-gate: baseline-freeze ==="
  cd "${REPO_ROOT}"

  echo "  Running bun test --coverage …"
  local cov_out
  # shellcheck disable=SC2086
  cov_out=$(bun test --coverage ${TEST_DIRS} 2>&1)

  # Verify tests are clean before freezing
  local summary
  summary=$(parse_bun_summary "$cov_out")
  local fail error
  fail=$(echo "$summary"  | grep -oE 'FAIL=[0-9]+'  | cut -d= -f2)
  error=$(echo "$summary" | grep -oE 'ERROR=[0-9]+' | cut -d= -f2)
  if [ "${fail:-0}" -gt 0 ] || [ "${error:-0}" -gt 0 ]; then
    echo "  ERROR: Test suite is not clean (fail=${fail:-0} error=${error:-0})."
    echo "  Fix failing tests before freezing the baseline."
    return 1
  fi

  # Write baseline
  echo "$cov_out" | parse_coverage_table > "$BASELINE_FILE"

  local line_count
  line_count=$(wc -l < "$BASELINE_FILE" | tr -d ' ')
  echo "  Baseline written to: ${BASELINE_FILE}"
  echo "  Tracked entries: ${line_count}"

  local aggregate
  aggregate=$(awk -F$'\t' '$1=="ALL_FILES" {print $2}' "$BASELINE_FILE")
  echo "  Aggregate % Lines: ${aggregate}%"
  echo "=== baseline-freeze: DONE ==="
}

# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
MODE="${1:-full}"
shift || true   # consume mode arg; remaining positional args go to mode handler

cd "${REPO_ROOT}"

case "$MODE" in
  full)            mode_full "$@" ;;
  solo)            mode_solo "$@" ;;
  compare)         mode_compare "$@" ;;
  shuffle)         mode_shuffle "$@" ;;
  coverage)        mode_coverage "$@" ;;
  baseline-freeze) mode_baseline_freeze "$@" ;;
  *)
    echo "Unknown mode: '${MODE}'"
    echo "Usage: bash scripts/test-gate.sh {full|solo|compare|shuffle|coverage|baseline-freeze} [args...]"
    exit 2
    ;;
esac
