//go:build windows

package main

import (
	"fmt"
	"os"
)

func runDaemon(string) {
	fmt.Fprintln(os.Stderr, "agent: --daemon is not supported on Windows")
	os.Exit(2)
}

func runDialer(string) {
	fmt.Fprintln(os.Stderr, "agent: --dial is not supported on Windows")
	os.Exit(2)
}
