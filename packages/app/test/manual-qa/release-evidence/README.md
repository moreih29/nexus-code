# Manual QA Release Evidence (Task 12)

Store signed-app native QA evidence for Korean release blocking checks.

## Structure

Create one folder per run:

```text
release-evidence/<RUN_ID>/
  evidence.md
  release-notes-snippet.md
  latency-samples.csv
  arm64/
  x64/
```

Use templates in this directory:

- `manual-qa-evidence.template.md`
- `release-notes-snippet.template.md`
- `korean-latency-samples.template.csv`

## Policy

- This folder is the source of truth for Task 12 manual gate outcomes.
- Do **not** mark release-ready without a completed evidence bundle and PASS verdict for both arm64 + x64.
