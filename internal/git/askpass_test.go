package git

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"
)

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
