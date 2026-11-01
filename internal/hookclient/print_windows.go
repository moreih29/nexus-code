//go:build windows

package hookclient

import "os"

// forwardedSignals: Windows reaches every process of the console with ^C.
var forwardedSignals = []os.Signal{os.Interrupt}

var swallowedSignals = []os.Signal{}

// signalOf: a process on Windows ends with an exit code alone.
func signalOf(*os.ProcessState) (int, string, bool) { return 0, "", false }

func reraise(int) {}
