//go:build !darwin && !linux

package agentrun

import "github.com/nexus-code/nexus-code/internal/agentpaths"

func runSocketDir(preferred, _ string) string { return preferred }

func ensurePrivateSocketDir(dir string) error { return agentpaths.EnsureDir(dir) }
