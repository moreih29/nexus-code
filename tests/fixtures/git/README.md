# Git parser parity fixtures

These fixtures are manually authored golden inputs for the Go git semantic-method tests.
They are intentionally not generated from the current TypeScript parser or any Go parser.

Each case directory contains:

- `stdout.bin`: raw Git stdout bytes for the documented command shape.
- `expected.json`: intended semantic method events/result envelope.
- `meta.json`: provenance, Git version, `LANG=C`, and review notes.

Domains:

- `log`: custom pretty-format records separated by `0x1f` fields and `0x1e` records.
- `diff`: raw UTF-8 diff text chunks, including a 4-byte emoji boundary case.
- `blob`: `git cat-file --batch` header/body stdout and base64 chunk expectations.
- `commit-detail`: `git show --name-status -z` style NUL-separated stdout.

Lead/Reviewer sign-off is still required before treating these as canonical.
