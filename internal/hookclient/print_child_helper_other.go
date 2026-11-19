//go:build !darwin

package hookclient

// PrintChildHelper handles the macOS-only print child and watcher entrypoints.
func PrintChildHelper([]string) (int, bool) { return 0, false }
