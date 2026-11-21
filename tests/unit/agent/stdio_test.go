package agent_test

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nexus-code/nexus-code/internal/dispatch"
	"github.com/nexus-code/nexus-code/internal/fs"
	"github.com/nexus-code/nexus-code/internal/proto"
	"github.com/nexus-code/nexus-code/internal/stdioserver"
)

func TestOversizeFileFramesPreserveConnection(t *testing.T) {
	root, service := filesystem(t)
	file, err := os.Create(filepath.Join(root, "large.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte{0xff, 0xfe}); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Truncate(49 << 20); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	input, clientIn := io.Pipe()
	clientOut, output := io.Pipe()
	d := dispatch.New()
	fs.Register(d, service)
	d.Register("ping", func(context.Context, json.RawMessage) (any, error) { return true, nil })
	host := stdioserver.New(d, input, output, slog.New(slog.NewTextHandler(io.Discard, nil)))
	host.SetExitFunc(func(int) {})
	go host.Run()
	defer input.Close()
	defer clientIn.Close()
	defer clientOut.Close()
	defer output.Close()

	scanner := bufio.NewScanner(clientOut)
	roundTrip := func(request string) proto.Response {
		t.Helper()
		if _, err := io.WriteString(clientIn, request+"\n"); err != nil {
			t.Fatal(err)
		}
		if !scanner.Scan() {
			t.Fatalf("no bounded response: %v", scanner.Err())
		}
		var response proto.Response
		if err := json.Unmarshal(scanner.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		return response
	}
	response := roundTrip(`{"id":"read","method":"fs.readFile","params":{"relPath":"large.txt"}}`)
	if response.ID != "read" || response.Error == nil || response.Error.Code != fs.CodeTransferTooLarge {
		t.Fatalf("read response = %#v", response)
	}
	encoded := strings.Repeat("A", 4*((49<<20+2)/3))
	write := roundTrip(`{"id":"write","method":"fs.writeFile","params":{"relPath":"large.txt","bytes":"` + encoded + `"}}`)
	if write.ID != "write" || write.Error == nil || write.Error.Code != fs.CodeTransferTooLarge {
		t.Fatalf("write response = %#v", write)
	}
	if ping := roundTrip(`{"id":"ping","method":"ping"}`); ping.ID != "ping" || ping.Result != true {
		t.Fatalf("ping response = %#v", ping)
	}
}
