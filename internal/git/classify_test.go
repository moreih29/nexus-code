package git

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"
)

type expectedClassifiedError struct {
	Kind    Kind                   `json:"kind"`
	Message string                 `json:"message"`
	Hint    map[string]interface{} `json:"hint"`
}

func TestClassifyStderrFixtures(t *testing.T) {
	fixtureRoot := fixtureDir("stderr")
	cases, err := os.ReadDir(fixtureRoot)
	if err != nil {
		t.Fatalf("read stderr fixtures: %v", err)
	}

	loaded := 0
	for _, entry := range cases {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		dir := filepath.Join(fixtureRoot, name)
		stderrBytes, err := os.ReadFile(filepath.Join(dir, "stderr.bin"))
		if err != nil {
			t.Fatalf("%s: read stderr.bin: %v", name, err)
		}
		expectedBytes, err := os.ReadFile(filepath.Join(dir, "expected.json"))
		if err != nil {
			t.Fatalf("%s: read expected.json: %v", name, err)
		}
		var expected expectedClassifiedError
		if err := json.Unmarshal(expectedBytes, &expected); err != nil {
			t.Fatalf("%s: parse expected.json: %v", name, err)
		}

		stderr := string(stderrBytes)
		if got := Classify(stderr); got != expected.Kind {
			t.Errorf("%s: kind got %q want %q", name, got, expected.Kind)
		}
		if got := MessageForKind(expected.Kind, MessageContext{Stderr: stderr}); got != expected.Message {
			t.Errorf("%s: message got %q want %q", name, got, expected.Message)
		}
		if got := hintMap(t, HintForKind(expected.Kind)); !reflect.DeepEqual(got, expected.Hint) {
			t.Errorf("%s: hint got %#v want %#v", name, got, expected.Hint)
		}
		loaded++
	}
	if loaded == 0 {
		t.Fatal("no stderr fixtures loaded")
	}
	t.Logf("loaded %d stderr fixtures", loaded)
}

func TestRunStdoutOverflowIsClassifiedData(t *testing.T) {
	service := New(t.TempDir())
	var result any
	var err error
	if runtime.GOOS == "windows" {
		result, err = runOverflowingGitLauncher(t, service)
	} else {
		setFakeGitExecutable(t, "output-budget")
		result, err = service.Run(context.Background(), json.RawMessage(`{"args":["bulk","1025"],"stdoutCapBytes":1024}`))
	}
	if err != nil {
		t.Fatalf("Run returned transport error: %v", err)
	}
	runResult, ok := result.(RunResult)
	if !ok {
		t.Fatalf("Run result type = %T", result)
	}
	if runResult.Code != 0 {
		t.Fatalf("Code got %d want 0", runResult.Code)
	}
	if runResult.ErrorKind != KindOutputTooLarge {
		t.Fatalf("ErrorKind got %q want %q", runResult.ErrorKind, KindOutputTooLarge)
	}
	if runResult.ErrorMessage == "" {
		t.Fatal("ErrorMessage is empty")
	}
}

func runOverflowingGitLauncher(t *testing.T, service *Service) (any, error) {
	t.Helper()
	setupInheritedPipeFixture(t)
	listener := listenForPipeHolder(t)
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	type response struct {
		value any
		err   error
	}
	done := make(chan response, 1)
	go func() {
		value, err := service.Run(ctx, json.RawMessage(`{"args":["overflow"],"stdoutCapBytes":1024}`))
		done <- response{value, err}
	}()
	conn, err := listener.AcceptTCP()
	if err != nil {
		t.Fatal("Git child never connected:", err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte{1}); err != nil {
		t.Fatal(err)
	}
	select {
	case reply := <-done:
		if reply.err != nil {
			return nil, reply.err
		}
		if err := os.Remove(service.root); err != nil {
			t.Fatalf("Git's working directory is still in use after Run: %v", err)
		}
		if err := conn.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
			t.Fatal(err)
		}
		n, err := conn.Read(make([]byte, 1))
		var networkErr net.Error
		if n != 0 || err == nil || (errors.As(err, &networkErr) && networkErr.Timeout()) {
			t.Fatalf("overflow left Git's child running: read %d bytes, error %v", n, err)
		}
		return reply.value, nil
	case <-ctx.Done():
		t.Fatal("git.run did not return after overflow")
		return nil, nil
	}
}

func hintMap(t *testing.T, hint *ActionHint) map[string]interface{} {
	t.Helper()
	if hint == nil {
		return nil
	}
	bytes, err := json.Marshal(hint)
	if err != nil {
		t.Fatalf("marshal hint: %v", err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(bytes, &decoded); err != nil {
		t.Fatalf("unmarshal hint: %v", err)
	}
	normalizeMap(decoded)
	return decoded
}

func normalizeMap(value map[string]interface{}) {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if value[key] == nil {
			delete(value, key)
		}
	}
}

func TestGitFailureMasksCredentials(t *testing.T) {
	result := buildRunResult("", "fatal: https://user:fake-password@example.test/a?token=fake-query&ok=1 Authorization: Bearer fake-auth API_KEY=\"fake with space\" APP_TOKEN=fake-token APP_SECRET=fake-secret", 1, nil)
	for _, got := range []string{result.Stderr, result.ErrorMessage} {
		if strings.Contains(got, "fake") || !strings.Contains(got, "example.test/a?token=") || !strings.Contains(got, "&ok=1") {
			t.Errorf("unexpected Git diagnostic %q", got)
		}
	}
	got := buildRunResult("", "", 128, []string{"fetch", "https://user:fake-argv@example.test/a"}).ErrorMessage
	if strings.Contains(got, "fake") || !strings.Contains(got, "git fetch") || !strings.Contains(got, "exited with code 128") {
		t.Errorf("unexpected Git command diagnostic %q", got)
	}
}
