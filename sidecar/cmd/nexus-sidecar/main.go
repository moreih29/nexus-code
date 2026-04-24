package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

func main() {
	fmt.Fprintf(os.Stderr, "nexus-sidecar started pid=%d argv=%v\n", os.Getpid(), os.Args)

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGHUP, syscall.SIGTERM, syscall.SIGINT)
	defer signal.Stop(signals)

	for {
		sig := <-signals
		switch sig {
		case syscall.SIGHUP, syscall.SIGTERM, syscall.SIGINT:
			fmt.Fprintln(os.Stderr, "nexus-sidecar shutting down")
			return
		}
	}
}
