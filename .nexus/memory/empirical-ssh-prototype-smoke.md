# empirical: SSH prototype smoke

Date: 2026-05-12

## Environment

- Local OpenSSH client exists: `OpenSSH_10.2p1, LibreSSL 3.3.6`.
- `localhost:22` is not available: `Connection refused`.
- Config aliases `monolith` and `monolith2` are reachable with BatchMode.
- Both reachable aliases lack `bun` on PATH and do not have `/Users/kih/workspaces/areas/nexus-code`, so the positive remote agent round trip could not be completed in this environment.

## Results

- Backend negative smoke, unreachable host: `workspace.testSsh` returned `{ok:false, code:"ssh.connect-failed", message:"SSH connection failed"}`.
- Backend negative smoke, reachable host without remote agent runtime (`monolith2`, `/home/kih`): `workspace.testSsh` returned `{ok:false, code:"agent.spawn-failed", message:"Remote agent failed to start"}`.
- Temporary SSH process cleanup: no leaked `ssh ... bash -lc cd /home/kih` child process was detected after the failed validation.

## Not Completed

- Positive Add Workspace -> SSH -> sidebar status -> file tree expand -> file open round trip was blocked by missing remote prerequisites (`bun` and repo checkout).
- Authentication-failure UI smoke was not run against a real host; failure mapping is covered by unit tests and stderr classification tests.

## Follow-up

- Prepare a remote host with this repo checked out and `bun` on PATH, then rerun the positive UI smoke.
- Keep `BatchMode=yes` in the prototype path so missing passphrase/password setup fails quickly instead of hanging the dialog.
