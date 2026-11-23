package proto

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"testing"
)

func TestDecodeParamsRefusesNoParams(t *testing.T) {
	for _, raw := range []string{"", "  ", "null", " null\n", "{", "[]"} {
		var target struct {
			ID string `json:"id"`
		}
		err := DecodeParams(json.RawMessage(raw), &target, "x needs params")
		if ErrorCode(err) != CodeProtocolError || err.Error() != "x needs params" {
			t.Fatalf("%q: err = %v", raw, err)
		}
	}
	var target struct {
		ID string `json:"id"`
	}
	if err := DecodeParams(json.RawMessage(` {"id":"a"} `), &target, "x"); err != nil || target.ID != "a" {
		t.Fatalf("err %v, target %+v", err, target)
	}
}

func TestTabKeyFromNamesWhatIsMissing(t *testing.T) {
	for _, c := range []struct{ workspace, tab, want string }{
		{"", "t", "m workspaceId is required"},
		{" ", "t", "m workspaceId is required"},
		{"w", "", "m tabId is required"},
	} {
		if _, err := TabKeyFrom(c.workspace, c.tab, "m"); err == nil || err.Error() != c.want || ErrorCode(err) != CodeProtocolError {
			t.Fatalf("%+v: err = %v", c, err)
		}
	}
	if key, err := TabKeyFrom(" w ", " t ", "m"); err != nil || key != (TabKey{WorkspaceID: "w", TabID: "t"}) {
		t.Fatalf("key %+v, err %v", key, err)
	}
}

func TestExitStatusSaysAFailedWaitIsNoExitCode(t *testing.T) {
	for _, c := range []struct {
		state *os.ProcessState
		err   error
	}{{nil, nil}, {nil, errors.New("wait failed")}} {
		code, signal := ExitStatus(c.state, c.err)
		if code == nil || *code != -1 || signal != nil {
			t.Fatalf("%+v: code %v, signal %v", c, code, signal)
		}
	}
}

func TestExitStatusTellsTheExitCode(t *testing.T) {
	cmd := exec.Command("sh", "-c", "exit 3")
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", "/c", "exit 3")
	}
	_ = cmd.Run()
	code, signal := ExitStatus(cmd.ProcessState, nil)
	if code == nil || *code != 3 || signal != nil {
		t.Fatalf("code %v, signal %v", code, signal)
	}
}
