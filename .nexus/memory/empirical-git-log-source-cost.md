# empirical: `git log --source --all` cost

## Decision

Keep `--source` for all-branches log queries.

Threshold used for this benchmark: if `--source --all` is more than **25% slower** than the same `--all` query without `--source`, the IPC implementation should use a conditional/fallback path. The measured source overhead stayed below that threshold at every range, including the 50k target (`+1.06%`).

## Repository selection

- Current project repo: `/Users/kih/workspaces/areas/nexus-code`, `232` commits across all refs — too small for the 50k requirement.
- Large local reference repo used: `/Users/kih/workspaces/areas/nexus-code/references/vscode`
  - Branch at measurement time: `main`
  - HEAD: `5abf84634d6`
  - `git rev-list --count HEAD`: `156307`
  - `git rev-list --count --all`: `174064`
- Git version: `git version 2.50.1 (Apple Git-155)`
- Platform reported by Python: `macOS-26.3-arm64-arm-64bit-Mach-O`

## Method

- Date: 2026-05-11
- Each cell below is the average of 3 successful runs.
- All 27 measurement commands exited with code `0`.
- Stdout was redirected to `/dev/null`; stderr was captured for exit-code validation.
- Runs were interleaved in rotated variant order to reduce order bias.
- No temporary files were retained.

Format aliases used to keep command shapes readable:

```text
FORMAT_BASE=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%D%x1e
FORMAT_SOURCE=%S%x1f%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1f%D%x1e
```

`FORMAT_BASE` matches the existing log payload plus planned `%D` ref decoration. `FORMAT_SOURCE` adds planned `%S` source-ref payload for the `--source` variant.

## Measurements

| Range | Variant | Command shape | Runs (ms) | Avg (ms) | Delta vs `--all` | Exit codes |
|---:|---|---|---:|---:|---:|---|
| 1k | `--source --all` | `git -C references/vscode --no-pager log --pretty=format:$FORMAT_SOURCE --date=iso-strict --max-count=1000 --source --all` | `98.020`, `69.491`, `72.675` | `80.062` | `+7.913 ms` / `+10.97%` | `0,0,0` |
| 1k | `--all` | `git -C references/vscode --no-pager log --pretty=format:$FORMAT_BASE --date=iso-strict --max-count=1000 --all` | `70.789`, `73.989`, `71.669` | `72.149` | baseline | `0,0,0` |
| 1k | single-ref `HEAD` | `git -C references/vscode --no-pager log --pretty=format:$FORMAT_BASE --date=iso-strict --max-count=1000 HEAD` | `43.946`, `42.774`, `43.077` | `43.266` | `-28.883 ms` / `-40.03%` | `0,0,0` |
| 10k | `--source --all` | `git -C references/vscode --no-pager log --pretty=format:$FORMAT_SOURCE --date=iso-strict --max-count=10000 --source --all` | `175.227`, `171.542`, `169.768` | `172.179` | `+3.707 ms` / `+2.20%` | `0,0,0` |
| 10k | `--all` | `git -C references/vscode --no-pager log --pretty=format:$FORMAT_BASE --date=iso-strict --max-count=10000 --all` | `168.039`, `168.772`, `168.606` | `168.472` | baseline | `0,0,0` |
| 10k | single-ref `HEAD` | `git -C references/vscode --no-pager log --pretty=format:$FORMAT_BASE --date=iso-strict --max-count=10000 HEAD` | `144.495`, `142.032`, `145.482` | `144.003` | `-24.469 ms` / `-14.52%` | `0,0,0` |
| 50k | `--source --all` | `git -C references/vscode --no-pager log --pretty=format:$FORMAT_SOURCE --date=iso-strict --max-count=50000 --source --all` | `594.885`, `594.053`, `596.104` | `595.014` | `+6.238 ms` / `+1.06%` | `0,0,0` |
| 50k | `--all` | `git -C references/vscode --no-pager log --pretty=format:$FORMAT_BASE --date=iso-strict --max-count=50000 --all` | `589.269`, `589.799`, `587.259` | `588.776` | baseline | `0,0,0` |
| 50k | single-ref `HEAD` | `git -C references/vscode --no-pager log --pretty=format:$FORMAT_BASE --date=iso-strict --max-count=50000 HEAD` | `578.323`, `580.033`, `582.331` | `580.229` | `-8.547 ms` / `-1.45%` | `0,0,0` |

Additional all-branches cost context: `--all` vs single-ref `HEAD` averaged `+28.883 ms / +66.76%` at 1k, `+24.469 ms / +16.99%` at 10k, and `+8.547 ms / +1.47%` at 50k.

## Interpretation

- The 1k `--source --all` cell has visible run-to-run noise because the first source run was slower (`98.020 ms`) while later source runs were close to `--all` (`69.491 ms`, `72.675 ms`). Even including that slower run, the average source delta was only `+10.97%`, under the 25% fallback threshold.
- At the higher and more relevant ranges, source overhead was small: `+2.20%` at 10k and `+1.06%` at 50k.
- The 50k measurement is the gating case for the planned graph panel. It does not support adding a fallback solely for `--source` cost.

## Recommendation

Proceed with `--source` for `scope="all"` / all-branches log IPC. Do not add a conditional/fallback path for `--source` based on this benchmark. Revisit only if user-visible latency appears on a different repository shape, such as a much larger monorepo with unusually many refs or pathological packfile state.
