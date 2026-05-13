// Binary agent is the workspace-bound Go process that the
// Electron main reaches over a per-workspace NDJSON channel
// (stdin/stdout in production; SSH-tunneled stdio for remote workspaces).
//
// This entry file is intentionally thin: it parses the workspace root
// from argv, builds the fsops registry, hands off to stdioserver, and
// emits the boot Ready frame. Everything past that — request scanning,
// goroutine dispatch, response serialization, signal handling — lives
// in internal/stdioserver so this file stays at a glance-readable size.
package main

import (
	"fmt"
	"os"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/fsops"
	"github.com/nexus-code/nexus-code/internal/proto"
	"github.com/nexus-code/nexus-code/internal/stdioserver"
)

func main() {
	root := rootPathFromArgv(os.Args)
	if root == "" {
		fmt.Fprintln(os.Stderr, "Usage: agent <rootPath>")
		os.Exit(2)
	}

	fsys, err := fsops.New(root)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	d := dispatch.New()
	fsops.Register(d, fsys)

	host := stdioserver.New(d, os.Stdin, os.Stdout)
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
