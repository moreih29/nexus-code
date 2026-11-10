//go:build !windows

package pty

import (
	"context"
	"fmt"
	"io"
	"math/rand"
	"net"
	"os"
	"regexp"
	"strconv"
	"testing"
	"time"
)

const listenerHelperEnv = "NEXUS_PTY_TEST_LISTENER"

// TestPtyListenerHelper is the program TestListeningPortsSeesATerminalsServer
// runs in its terminal: it listens on a port below the dynamic range, prints
// it, and holds it until its stdin closes.
func TestPtyListenerHelper(t *testing.T) {
	if os.Getenv(listenerHelperEnv) != "1" {
		t.Skip("run by TestListeningPortsSeesATerminalsServer")
	}
	for attempt := 0; attempt < 50; attempt++ {
		port := 20000 + rand.Intn(12000)
		listener, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
		if err != nil {
			continue
		}
		fmt.Printf("LISTENING=%d\n", port)
		_, _ = io.Copy(io.Discard, os.Stdin)
		_ = listener.Close()
		return
	}
	t.Fatal("no free port")
}

func TestListeningPortsSeesATerminalsServer(t *testing.T) {
	t.Parallel()
	service, recorder := newTestService(t)
	tabID := "dev-server"
	spawnTestScript(t, service, tabID, fmt.Sprintf(`
stty -echo
%s=1 %q -test.run='^TestPtyListenerHelper$'
`, listenerHelperEnv, os.Args[0]))
	recorder.requireTranscriptContains(t, "LISTENING=", 10*time.Second)
	match := regexp.MustCompile(`LISTENING=(\d+)`).FindStringSubmatch(recorder.transcript())
	port, _ := strconv.Atoi(match[1])

	result, err := service.ListeningPorts(context.Background(), mustJSON(t, ListeningPortsParams{WorkspaceID: testWorkspaceID}))
	if err != nil {
		t.Fatalf("ListeningPorts() error = %v", err)
	}
	for _, listening := range result.(ListeningPortsResult).Ports {
		if listening.Port == port {
			if listening.TabID != tabID || listening.PID <= 0 || listening.Process == "" {
				t.Fatalf("ListeningPorts() = %+v, want port %d in tab %s", listening, port, tabID)
			}
			return
		}
	}
	t.Fatalf("ListeningPorts() = %+v, missing port %d", result, port)
}
