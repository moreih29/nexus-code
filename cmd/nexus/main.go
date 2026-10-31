// Command nexus is the nexus command of local Windows terminals: the CLI
// client on its own, which cmd and PowerShell run as a program. A .cmd
// launcher would have cmd read the arguments again, taking &, |, <, > and ^
// in them for its own. Elsewhere a shell script runs `agent cli`.
package main

import (
	"os"

	"github.com/nexus-code/nexus-code/internal/cliclient"
)

func main() {
	os.Exit(cliclient.Run(os.Args[1:]))
}
