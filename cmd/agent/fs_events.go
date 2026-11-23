package main

import (
	"github.com/nexus-code/nexus-code/internal/filewatch"
	agentfs "github.com/nexus-code/nexus-code/internal/fs"
	agentlsp "github.com/nexus-code/nexus-code/internal/lsp"
	"github.com/nexus-code/nexus-code/internal/stdioserver"
)

func fsEventSink(host *stdioserver.Host, lsp *agentlsp.Service) agentfs.EventSink {
	return func(event string, payload any) error {
		err := host.EmitEvent(event, payload)
		if event == "fs.changed" {
			if changed, ok := payload.(filewatch.FsChangedPayload); ok {
				if routeErr := lsp.HandleFSChanged(changed); err == nil {
					err = routeErr
				}
			}
		}
		return err
	}
}
