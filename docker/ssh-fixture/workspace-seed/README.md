# workspace-seed

Sample workspace mounted into the SSH fixture at `/home/nexus-dev/workspace`.

Used as the target for fs/git/lsp/search round-trip tests against the remote
Go agent. Edits made from the host side are visible inside the container
immediately (bind mount).
