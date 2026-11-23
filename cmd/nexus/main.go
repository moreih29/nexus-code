package main

import (
	"os"

	"github.com/nexus-code/nexus-code/internal/cliclient"
)

func main() {
	os.Exit(cliclient.Run(os.Args[1:]))
}
