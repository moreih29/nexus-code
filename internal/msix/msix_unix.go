//go:build !windows

package msix

// AgentAlias reports that there is no alias: MSIX packages are Windows only.
func AgentAlias() (string, bool) {
	return "", false
}

// InstallDir reports that there is no package: MSIX packages are Windows only.
func InstallDir() (string, bool) {
	return "", false
}
