//go:build windows

package main

import (
	"fmt"
	"os"
)

// The daemon and the dialer run only on SSH hosts (macOS and Linux), where
// they keep a workspace alive across connections. On Windows the agent serves
// the local app over stdio alone.

func runDaemon(string) {
	fmt.Fprintln(os.Stderr, "agent: --daemon is not supported on Windows")
	os.Exit(2)
}

func runDialer(string) {
	fmt.Fprintln(os.Stderr, "agent: --dial is not supported on Windows")
	os.Exit(2)
}
