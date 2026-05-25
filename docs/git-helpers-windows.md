# Git helpers Windows manual verification

Use this when automated CI does not run on Windows with Git for Windows.

1. Install Git for Windows and ensure `git.exe` is on `PATH`.
2. Launch NexusCode from PowerShell on the feature branch.
3. Open a repository whose `origin` is an HTTPS remote requiring credentials.
4. Run Fetch or Push from Source Control.
5. Verify the “Awaiting credentials…” banner appears, username then password prompts reuse one modal, cancel aborts the Git operation, and a successful response lets Git continue.
6. Create a staged change, trigger a commit flow that invokes `GIT_EDITOR`, save the modal, and verify Git exits 0. Repeat and cancel; verify Git aborts with the app’s `commit-aborted` classification.
7. In a PowerShell session, verify helper env shape: `GIT_ASKPASS`/`GIT_EDITOR` should be generated `.cmd` wrapper paths, and `NEXUS_HELPERS_SOCKET=\\.\pipe\nexus-helpers-<pid>` should keep the Windows named-pipe prefix.
