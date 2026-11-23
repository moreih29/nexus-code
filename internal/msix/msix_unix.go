//go:build !windows

package msix

func AgentAlias() (string, bool) {
	return "", false
}

func InstallDir() (string, bool) {
	return "", false
}
