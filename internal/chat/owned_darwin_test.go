//go:build darwin

package chat

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func startedProgram(t *testing.T, script string) (ownedIdentity, *exec.Cmd) {
	t.Helper()
	cmd := exec.Command("/bin/sh", "-c", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	reaped := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(reaped)
	}()
	t.Cleanup(func() {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		_ = cmd.Process.Kill()
		<-reaped
	})
	return runningIdentity(cmd.Process.Pid), cmd
}

func deadIdentity(t *testing.T) ownedIdentity {
	t.Helper()
	cmd := exec.Command("/bin/sleep", "30")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	id := runningIdentity(cmd.Process.Pid)
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	if id.Start == 0 || running(id) {
		t.Fatalf("identity %+v", id)
	}
	return id
}

func childOf(t *testing.T, pid int) ownedIdentity {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if children := descendants(pid); len(children) > 0 {
			return runningIdentity(children[0])
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("no child of %d", pid)
	return ownedIdentity{}
}

func writeRecord(t *testing.T, dir, name string, record ownedRecord) string {
	t.Helper()
	data, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestEndOrphansEndsWhatADeadAgentOfThisAppLeftInThisWorkspace(t *testing.T) {
	dir := t.TempDir()
	app := runningIdentity(os.Getpid())
	program, _ := startedProgram(t, "/bin/sleep 60 & wait")
	tool := childOf(t, program.PID)
	path := writeRecord(t, dir, "ws1-1.json", ownedRecord{
		Workspace: "ws1", Agent: deadIdentity(t), Parent: app, Programs: []ownedIdentity{program},
	})

	started := time.Now()
	ended := endOrphans(dir, "ws1", app)

	if len(ended) != 1 || ended[0] != program.PID {
		t.Fatalf("ended = %v, want [%d]", ended, program.PID)
	}
	if running(program) || running(tool) {
		t.Fatalf("still running: program %v, tool %v", running(program), running(tool))
	}
	if exists(path) {
		t.Fatal("the dead agent's record is still there")
	}
	if waited := time.Since(started); waited > orphanEndWait {
		t.Fatalf("took %s", waited)
	}
}

func TestEndOrphansEndsWhatADeadAgentOfADeadAppLeft(t *testing.T) {
	dir := t.TempDir()
	program, _ := startedProgram(t, "exec /bin/sleep 60")
	path := writeRecord(t, dir, "ws1-1.json", ownedRecord{
		Workspace: "ws1", Agent: deadIdentity(t), Parent: deadIdentity(t), Programs: []ownedIdentity{program},
	})

	endOrphans(dir, "ws1", runningIdentity(os.Getpid()))

	if running(program) || exists(path) {
		t.Fatalf("program running %v, record kept %v", running(program), exists(path))
	}
}

func TestEndOrphansLeavesEveryOtherProgramAlone(t *testing.T) {
	dir := t.TempDir()
	app := runningIdentity(os.Getpid())
	otherApp, _ := startedProgram(t, "exec /bin/sleep 60")
	program, _ := startedProgram(t, "exec /bin/sleep 60")
	reused := ownedIdentity{PID: program.PID, Start: program.Start + 1}
	kept := []ownedRecord{
		{Workspace: "ws1", Agent: app, Parent: app, Programs: []ownedIdentity{program}},
		{Workspace: "ws1", Agent: deadIdentity(t), Parent: otherApp, Programs: []ownedIdentity{program}},
		{Workspace: "ws2", Agent: deadIdentity(t), Parent: app, Programs: []ownedIdentity{program}},
	}
	var paths []string
	for i, record := range kept {
		paths = append(paths, writeRecord(t, dir, record.Workspace+"-"+strconv.Itoa(i)+".json", record))
	}
	reusedPath := writeRecord(t, dir, "ws1-9.json", ownedRecord{
		Workspace: "ws1", Agent: deadIdentity(t), Parent: app, Programs: []ownedIdentity{reused},
	})

	ended := endOrphans(dir, "ws1", app)

	if len(ended) != 0 || !running(program) || !running(otherApp) {
		t.Fatalf("ended %v, program running %v, other app running %v", ended, running(program), running(otherApp))
	}
	for _, path := range paths {
		if !exists(path) {
			t.Fatalf("%s was removed", path)
		}
	}
	if exists(reusedPath) {
		t.Fatal("a record whose program is gone stays")
	}
}

func TestOwnedProgramsAreRecordedWhileTheyRun(t *testing.T) {
	dir := t.TempDir()
	if _, err := TrackOwnedPrograms(dir, "ws1"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { owned.Store(nil) })
	path := filepath.Join(dir, "ws1-"+strconv.Itoa(os.Getpid())+".json")

	cmd := exec.Command("/bin/sleep", "60")
	p := &process{cmd: cmd}
	if err := p.startOwned(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var record ownedRecord
	if err := json.Unmarshal(data, &record); err != nil {
		t.Fatal(err)
	}
	want := runningIdentity(cmd.Process.Pid)
	if record.Workspace != "ws1" || record.Agent != runningIdentity(os.Getpid()) ||
		record.Parent != runningIdentity(os.Getppid()) || len(record.Programs) != 1 || record.Programs[0] != want {
		t.Fatalf("record = %+v, want program %+v", record, want)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 || strings.HasSuffix(entries[0].Name(), ".tmp") {
		t.Fatalf("files = %v", entries)
	}

	_ = p.signalKill()
	_ = cmd.Wait()
	p.releaseTree()
	if exists(path) {
		t.Fatal("the record outlives the last program")
	}
}
