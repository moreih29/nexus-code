// Binary agent is the workspace-bound Go process that the
// Electron main reaches over a per-workspace NDJSON channel
// (stdin/stdout in production; SSH-tunneled stdio for remote workspaces).
//
// This entry file is intentionally thin: it parses the workspace root
// from argv, builds the fs registry, hands off to stdioserver, and
// emits the boot Ready frame. Everything past that — request scanning,
// goroutine dispatch, response serialization, signal handling — lives
// in internal/stdioserver so this file stays at a glance-readable size.
package main

import (
	"fmt"
	"os"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	agentfs "github.com/nexus-code/nexus-code/internal/fs"
	agentgit "github.com/nexus-code/nexus-code/internal/git"
	agentlsp "github.com/nexus-code/nexus-code/internal/lsp"
	"github.com/nexus-code/nexus-code/internal/proto"
	agentsearch "github.com/nexus-code/nexus-code/internal/search"
	"github.com/nexus-code/nexus-code/internal/stdioserver"
)

func main() {
	if code, ok := askpassExitFromArgv(os.Args); ok {
		os.Exit(code)
	}

	root := rootPathFromArgv(os.Args)
	if root == "" {
		fmt.Fprintln(os.Stderr, "Usage: agent <rootPath>")
		os.Exit(2)
	}

	fsys, err := agentfs.New(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	git := agentgit.New(root)
	lsp := agentlsp.New()
	search, err := agentsearch.New(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	d := dispatch.New()
	agentfs.Register(d, fsys)
	agentgit.Register(d, git)
	agentlsp.Register(d, lsp)
	agentsearch.Register(d, search)

	host := stdioserver.New(d, os.Stdin, os.Stdout)
	fsys.SetEventSink(func(event string, payload any) error {
		err := host.EmitEvent(event, payload)
		if event == "fs.changed" {
			if changed, ok := payload.(agentfs.FsChangedPayload); ok {
				if routeErr := lsp.HandleFSChanged(changed); err == nil {
					err = routeErr
				}
			}
		}
		return err
	})
	git.SetEventSink(host.EmitEvent)
	lsp.SetEventSink(host.EmitEvent)
	search.SetEventSink(host.EmitEvent)
	defer fsys.Close()
	defer git.Close()
	defer lsp.Close()
	host.InstallSigtermHandler()

	// Ready frame must reach the client before any other output so the
	// channel handshake on the TS side can settle. A write failure here
	// is unrecoverable — without a Ready, the client will time out.
	if err := host.WriteFrame(proto.Ready()); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	host.Run()
}

// rootPathFromArgv extracts the workspace root from argv. We accept
// exactly one positional argument and return "" when it is missing so
// the caller can print usage and exit non-zero.
func rootPathFromArgv(argv []string) string {
	if len(argv) > 1 {
		return argv[1]
	}
	return ""
}

// askpassExitFromArgv detects both the explicit `agent --askpass <socket>`
// helper mode and the Git-compatible env mode used when GIT_ASKPASS can only
// name an executable path.
func askpassExitFromArgv(argv []string) (int, bool) {
	if len(argv) >= 3 && argv[1] == "--askpass" {
		return agentgit.RunAskpassHelper(argv[2], argv[3:], os.Stdout, os.Stderr), true
	}
	if socketPath, ok := agentgit.AskpassSocketFromEnv(); ok {
		return agentgit.RunAskpassHelper(socketPath, argv[1:], os.Stdout, os.Stderr), true
	}
	return 0, false
}
