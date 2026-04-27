#!/usr/bin/env bash
set -euo pipefail

# Guard against the plan #16 H1 regression: ajv-cli standalone validators emitted
# top-level CommonJS require(...) calls that survived into electron-vite ESM output
# and crashed at runtime with "require is not defined".
#
# Scope:
# - Electron ESM build output: packages/app/out/main and packages/app/out/renderer.
# - Electron packaged output: packages/app/dist, when present.
# - Generated shared contract sources, so generated *.validate.ts cannot reappear
#   with CJS require(...) before they are bundled.
# - Optional future JS build artifacts for shared/harness adapters and sidecar hook
#   command helpers, when those directories exist.
#
# Explicit allowlist:
# - packages/app/out/preload is intentionally not scanned. electron.vite.config.ts
#   emits preload as CommonJS (*.cjs), where require(...) is expected and does not
#   exercise the ESM runtime that this guard protects.
# - node_modules and .vite caches are not scanned; this guard is for first-party
#   generated/bundled artifacts.
#
# Run `bun run build` first when checking Electron output locally. Missing optional
# artifact roots are reported and skipped; CI runs this script after the build step.

repo_root="$(git rev-parse --show-toplevel)"

declare -a default_roots=(
  "packages/shared/src/contracts/generated"
  "packages/app/out/main"
  "packages/app/out/renderer"
  "packages/app/dist"
  "packages/shared/dist"
  "sidecar/bin"
)

if [[ -d "${repo_root}/packages/harness-adapters" ]]; then
  while IFS= read -r -d '' artifact_dir; do
    default_roots+=("${artifact_dir#${repo_root}/}")
  done < <(
    find "${repo_root}/packages/harness-adapters" \
      -type d \( -name dist -o -name out \) \
      -print0
  )
fi

if (($# > 0)); then
  roots=("$@")
else
  roots=("${default_roots[@]}")
fi

python3 - "$repo_root" "${roots[@]}" <<'PY'
from __future__ import annotations

import os
import sys
from pathlib import Path

REPO_ROOT = Path(sys.argv[1]).resolve()
ROOT_ARGS = sys.argv[2:]
SCANNED_SUFFIXES = {".js", ".mjs", ".ts", ".tsx"}
SKIP_DIRS = {"node_modules", ".vite", ".git", "coverage", "__snapshots__"}
IDENT_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$")


def display_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return path.resolve().as_posix()


def resolve_root(raw: str) -> Path:
    path = Path(raw)
    if not path.is_absolute():
        path = REPO_ROOT / path
    return path.resolve()


def candidate_files(root: Path) -> list[Path]:
    if root.is_file():
        return [root] if root.suffix in SCANNED_SUFFIXES else []

    files: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [dirname for dirname in dirnames if dirname not in SKIP_DIRS]
        current = Path(dirpath)
        for filename in filenames:
            path = current / filename
            if path.suffix in SCANNED_SUFFIXES:
                files.append(path)
    return sorted(files)


def is_identifier_char(char: str) -> bool:
    return char in IDENT_CHARS


def previous_non_whitespace_char(source: str, candidate_index: int) -> str:
    probe = candidate_index - 1
    while probe >= 0 and source[probe] in " \t\r\n":
        probe -= 1
    return source[probe] if probe >= 0 else ""


def find_forbidden_require_calls(source: str) -> list[tuple[int, int, str]]:
    findings: list[tuple[int, int, str]] = []
    lines = source.splitlines()
    index = 0
    line = 1
    column = 1
    length = len(source)
    mode = "code"
    code_contexts: list[dict[str, int | str]] = [{"type": "normal"}]
    escape = False

    def advance(char: str) -> None:
        nonlocal index, line, column
        index += 1
        if char == "\n":
            line += 1
            column = 1
        else:
            column += 1

    def inside_line_template_literal(candidate_index: int) -> bool:
        line_start = source.rfind("\n", 0, candidate_index) + 1
        backticks = 0
        escaped = False
        for template_char in source[line_start:candidate_index]:
            if escaped:
                escaped = False
                continue
            if template_char == "\\":
                escaped = True
                continue
            if template_char == "`":
                backticks += 1
        return backticks % 2 == 1

    while index < length:
        char = source[index]
        next_char = source[index + 1] if index + 1 < length else ""

        if mode == "line_comment":
            advance(char)
            if char == "\n":
                mode = "code"
            continue

        if mode == "block_comment":
            if char == "*" and next_char == "/":
                advance(char)
                advance(next_char)
                mode = "code"
            else:
                advance(char)
            continue

        if mode in {"single_quote", "double_quote"}:
            if escape:
                escape = False
                advance(char)
                continue

            if char == "\\":
                escape = True
                advance(char)
                continue

            if mode == "single_quote" and char == "'":
                mode = "code"
            elif mode == "double_quote" and char == '"':
                mode = "code"

            advance(char)
            continue

        if mode == "template":
            if escape:
                escape = False
                advance(char)
                continue

            if char == "\\":
                escape = True
                advance(char)
                continue

            if char == "`":
                mode = "code"
                advance(char)
                continue

            if char == "$" and next_char == "{":
                advance(char)
                advance(next_char)
                code_contexts.append({"type": "template_expr", "brace_depth": 1})
                mode = "code"
                continue

            advance(char)
            continue

        if char == "/" and next_char == "/":
            advance(char)
            advance(next_char)
            mode = "line_comment"
            continue

        if char == "/" and next_char == "*":
            advance(char)
            advance(next_char)
            mode = "block_comment"
            continue

        if char == "'":
            mode = "single_quote"
            advance(char)
            continue

        if char == '"':
            mode = "double_quote"
            advance(char)
            continue

        if char == "`":
            mode = "template"
            advance(char)
            continue

        context = code_contexts[-1]
        if context["type"] == "template_expr":
            if char == "{":
                context["brace_depth"] = int(context["brace_depth"]) + 1
                advance(char)
                continue

            if char == "}":
                next_depth = int(context["brace_depth"]) - 1
                advance(char)
                if next_depth == 0:
                    code_contexts.pop()
                    mode = "template"
                else:
                    context["brace_depth"] = next_depth
                continue

        if source.startswith("require", index):
            before = source[index - 1] if index > 0 else ""
            previous_significant = previous_non_whitespace_char(source, index)
            after_index = index + len("require")
            after = source[after_index] if after_index < length else ""
            if (
                not is_identifier_char(before)
                and not is_identifier_char(after)
                and previous_significant not in {".", "#"}
            ):
                probe = after_index
                while probe < length and source[probe] in " \t\r\n":
                    probe += 1
                if (
                    probe < length
                    and source[probe] == "("
                    and not inside_line_template_literal(index)
                ):
                    snippet = lines[line - 1].strip() if line - 1 < len(lines) else ""
                    findings.append((line, column, snippet))
            for matched_char in "require":
                advance(matched_char)
            continue

        advance(char)

    return findings


missing_roots: list[str] = []
scan_files: list[Path] = []
seen: set[Path] = set()

for raw_root in ROOT_ARGS:
    root = resolve_root(raw_root)
    if not root.exists():
        missing_roots.append(display_path(root))
        continue
    for path in candidate_files(root):
        resolved = path.resolve()
        if resolved not in seen:
            seen.add(resolved)
            scan_files.append(resolved)

failures: list[tuple[Path, int, int, str]] = []
for path in sorted(scan_files):
    try:
        source = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        # sidecar/bin may contain native binaries. Only text JS/TS artifacts are relevant.
        continue

    for line, column, snippet in find_forbidden_require_calls(source):
        failures.append((path, line, column, snippet))

if missing_roots:
    print("check-dist-require: skipped missing optional roots:")
    for root in missing_roots:
        print(f"  - {root}")
    if any(root.startswith("packages/app/out") for root in missing_roots):
        print("check-dist-require: run `bun run build` first to populate packages/app/out.")

if failures:
    print("check-dist-require: forbidden CommonJS require(...) calls found:", file=sys.stderr)
    for path, line, column, snippet in failures:
        print(f"{display_path(path)}:{line}:{column}: {snippet}", file=sys.stderr)
    sys.exit(1)

print(
    f"check-dist-require: no forbidden require(...) calls found "
    f"in {len(scan_files)} JS/TS artifact file(s)."
)
PY
