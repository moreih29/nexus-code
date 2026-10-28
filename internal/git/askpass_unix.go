//go:build !windows

package git

import "os"

// askpassHelperPath returns the program git starts as the askpass helper:
// this executable.
func askpassHelperPath() (string, error) {
	return os.Executable()
}
