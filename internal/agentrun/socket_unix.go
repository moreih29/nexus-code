//go:build darwin || linux

package agentrun

import "github.com/nexus-code/nexus-code/internal/agentpaths"

func runSocketDir(preferred, longestName string) string {
	dir, _, err := agentpaths.SocketDir(preferred, longestName)
	if err != nil {
		return preferred
	}
	return dir
}

func ensurePrivateSocketDir(dir string) error { return agentpaths.EnsurePrivateDir(dir) }
