package git

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

// TestMain lets the test binary double as the askpass helper: interactive
// commands name os.Executable() as GIT_ASKPASS, as the agent does.
func TestMain(m *testing.M) {
	if socketPath, ok := AskpassSocketFromEnv(); ok {
		os.Exit(RunAskpassHelper(socketPath, os.Args[1:], os.Stdout, os.Stderr))
	}
	os.Exit(m.Run())
}

// runAskpassPrompt runs the helper against the service's askpass socket and
// answers its prompt with the git.askpass.respond fields in answer.
func runAskpassPrompt(t *testing.T, answer string) (int, string) {
	t.Helper()
	service := New(t.TempDir())
	defer service.Close()
	service.SetEventSink(func(event string, payload any) error {
		request := payload.(askpassRequestPayload)
		go func() {
			params := `{"requestId":"` + request.RequestID + `",` + answer + `}`
			if _, err := service.RespondAskpass(context.Background(), json.RawMessage(params)); err != nil {
				t.Errorf("RespondAskpass: %v", err)
			}
		}()
		return nil
	})
	socketPath, err := service.ensureAskpassServer()
	if err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code := RunAskpassHelper(socketPath, []string{"Password for 'https://example.test':"}, &stdout, &stderr)
	return code, stdout.String()
}

func TestAskpassAnswerReachesHelper(t *testing.T) {
	code, stdout := runAskpassPrompt(t, `"secret":"hunter2"`)
	if code != 0 || stdout != "hunter2" {
		t.Fatalf("helper exit=%d stdout=%q", code, stdout)
	}
}

// A dismissed prompt must fail the helper so Git stops; printing the empty
// secret would make Git try an empty password.
func TestAskpassCancelFailsHelper(t *testing.T) {
	code, stdout := runAskpassPrompt(t, `"secret":"","cancelled":true`)
	if code == 0 || stdout != "" {
		t.Fatalf("helper exit=%d stdout=%q, want a failure with no output", code, stdout)
	}
}

// promptingRemote is an HTTP remote that asks for credentials on every
// request, so git calls the askpass helper.
func promptingRemote(t *testing.T) string {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("WWW-Authenticate", `Basic realm="test"`)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(server.Close)
	return server.URL + "/repo.git"
}

// Cancelling a run that waits on a credential prompt must end the request:
// the prompt fails, the orphaned helper exits, and git's pipes close.
func TestCancelledRunFailsItsCredentialPrompt(t *testing.T) {
	service := New(t.TempDir())
	defer service.Close()
	prompts := make(chan askpassRequestPayload, 4)
	service.SetEventSink(func(event string, payload any) error {
		if event == askpassRequestEvent {
			prompts <- payload.(askpassRequestPayload)
		}
		return nil
	})

	done := make(chan error, 1)
	go func() {
		params, _ := json.Marshal(RunParams{
			Args:        []string{"-c", "credential.helper=", "ls-remote", promptingRemote(t)},
			Interactive: true,
			RunID:       "run-1",
		})
		_, err := service.Run(context.Background(), params)
		done <- err
	}()

	select {
	case prompt := <-prompts:
		if prompt.RunID != "run-1" {
			t.Fatalf("prompt runId = %q, want run-1", prompt.RunID)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("git never asked for credentials")
	}
	if _, err := service.Cancel(context.Background(), json.RawMessage(`{"streamId":"run-1"}`)); err != nil {
		t.Fatal(err)
	}

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Run returned %v, want context.Canceled", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("cancelled run did not return")
	}
	service.mu.Lock()
	left := len(service.askpassPending)
	service.mu.Unlock()
	if left != 0 {
		t.Fatalf("%d prompts still pending after the run ended", left)
	}
}

// A prompt from a run that already ended has nobody to answer it.
func TestPromptForEndedRunFailsAtOnce(t *testing.T) {
	service := New(t.TempDir())
	defer service.Close()
	service.SetEventSink(func(event string, payload any) error {
		t.Errorf("prompt for an ended run reached the host: %v", payload)
		return nil
	})
	socketPath, err := service.ensureAskpassServer()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(askpassRunEnv, "ended-run")
	var stdout, stderr bytes.Buffer
	if code := RunAskpassHelper(socketPath, []string{"Password:"}, &stdout, &stderr); code == 0 {
		t.Fatalf("helper succeeded with %q", stdout.String())
	}
}
