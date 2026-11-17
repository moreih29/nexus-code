//go:build !windows

package pty

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// spawnInteractiveBash starts an interactive bash, without rc files, that
// keeps its history in histfile.
func spawnInteractiveBash(t *testing.T, service *Service, tabID, histfile string) {
	t.Helper()
	if _, err := os.Stat("/bin/bash"); err != nil {
		t.Skip("no /bin/bash here")
	}
	params := SpawnParams{
		WorkspaceID: testWorkspaceID, TabID: tabID, Cwd: t.TempDir(),
		Shell: "/bin/bash", Args: []string{"--norc", "--noprofile", "-i"},
		Env:  map[string]string{"HISTFILE": histfile, "PS1": "$ "},
		Cols: 80, Rows: 24,
	}
	if _, err := service.Spawn(context.Background(), mustJSON(t, params)); err != nil {
		t.Fatalf("spawn %s: %v", tabID, err)
	}
}

// backgroundPID matches a background job's pid as a whole line, so a pid
// still arriving is not taken for a shorter one.
var backgroundPID = regexp.MustCompile(`BG=(\d+)\r?\n`)

// startBackgroundJob has the tab's shell run command — which ends up running
// sleep — as a background job, and returns its pid once it runs sleep. The
// job is killed when the test ends.
//
// A job is waited for until it runs sleep because a hangup it gets earlier,
// between the shell's fork and its exec, is lost: the shell's own handler
// takes it there, as it does on any terminal closed that early.
func startBackgroundJob(t *testing.T, service *Service, recorder *eventRecorder, tabID, command string) int {
	t.Helper()
	writeSession(t, service, tabID, command+"\n")
	pid := 0
	for deadline := time.Now().Add(3 * time.Second); pid == 0; time.Sleep(10 * time.Millisecond) {
		if match := backgroundPID.FindStringSubmatch(recorder.transcript()); match != nil {
			pid, _ = strconv.Atoi(match[1])
		} else if time.Now().After(deadline) {
			t.Fatalf("the background job never started:\n%s", recorder.transcript())
		}
	}
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	for deadline := time.Now().Add(3 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		out, _ := exec.Command("ps", "-o", "comm=", "-p", strconv.Itoa(pid)).Output()
		if strings.HasSuffix(strings.TrimSpace(string(out)), "sleep") {
			return pid
		}
		if time.Now().After(deadline) {
			t.Fatalf("the background job never started sleep: %q", out)
		}
	}
}

// processState describes pid for a failure message, where /proc shows it.
func processState(pid int) string {
	status, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return ""
	}
	cmdline, _ := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	var b strings.Builder
	fmt.Fprintf(&b, "\n  cmdline: %q", cmdline)
	for _, line := range strings.Split(string(status), "\n") {
		for _, field := range []string{"State:", "PPid:", "NSsid:", "NSpgid:", "SigBlk:", "SigIgn:", "SigCgt:", "SigPnd:", "ShdPnd:"} {
			if strings.HasPrefix(line, field) {
				b.WriteString("\n  " + line)
			}
		}
	}
	return b.String()
}

// processGone reports whether pid has ended: it is no more, or it is a
// zombie its new parent has yet to wait for.
func processGone(pid int) bool {
	if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
		return true
	}
	out, err := exec.Command("ps", "-o", "stat=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return true // ps exits non-zero once the process is gone
	}
	return strings.HasPrefix(strings.TrimSpace(string(out)), "Z")
}

func requireGone(t *testing.T, pid int, within time.Duration, what string) {
	t.Helper()
	deadline := time.Now().Add(within)
	for !processGone(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("%s (pid %d) still running %v after its tab closed%s", what, pid, within, processState(pid))
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// Closing a tab hangs up its shell, which passes the hangup on to its jobs
// and saves its history before it ends. Killing the shell at once left its
// background jobs running with no terminal and lost the session's history.
func TestClosedTabsShellHangsUpItsJobsAndSavesItsHistory(t *testing.T) {
	t.Parallel()
	service, recorder := newTestService(t)
	histfile := filepath.Join(t.TempDir(), "history")
	spawnInteractiveBash(t, service, "bash", histfile)
	job := startBackgroundJob(t, service, recorder, "bash", "sleep 3001 & echo BG=$!")

	if _, err := service.Kill(context.Background(), mustJSON(t, KillParams{WorkspaceID: testWorkspaceID, TabID: "bash"})); err != nil {
		t.Fatalf("kill: %v", err)
	}
	recorder.requireExit(t, "bash", 3*time.Second)
	requireGone(t, job, 3*time.Second, "the background job")
	history, _ := os.ReadFile(histfile)
	if !strings.Contains(string(history), "sleep 3001") {
		t.Fatalf("the closed tab's history was not saved: %q", history)
	}
}

// What the user started with nohup outlives the tab, as it outlives a
// closed terminal anywhere.
func TestClosedTabLeavesANohupJobRunning(t *testing.T) {
	t.Parallel()
	service, recorder := newTestService(t)
	spawnInteractiveBash(t, service, "nohup", filepath.Join(t.TempDir(), "history"))
	job := startBackgroundJob(t, service, recorder, "nohup", "nohup sleep 3002 >/dev/null 2>&1 & echo BG=$!")

	if _, err := service.Kill(context.Background(), mustJSON(t, KillParams{WorkspaceID: testWorkspaceID, TabID: "nohup"})); err != nil {
		t.Fatalf("kill: %v", err)
	}
	recorder.requireExit(t, "nohup", 3*time.Second)
	time.Sleep(hangupGrace + 500*time.Millisecond)
	if processGone(job) {
		t.Fatal("the nohup job ended with its tab")
	}
}

// A job the user disowned is no longer the shell's to hang up, and outlives
// the tab as it outlives a closed terminal anywhere.
func TestClosedTabLeavesADisownedJobRunning(t *testing.T) {
	t.Parallel()
	service, recorder := newTestService(t)
	spawnInteractiveBash(t, service, "disown", filepath.Join(t.TempDir(), "history"))
	job := startBackgroundJob(t, service, recorder, "disown", "sleep 3005 >/dev/null 2>&1 & disown; echo BG=$!")

	if _, err := service.Kill(context.Background(), mustJSON(t, KillParams{WorkspaceID: testWorkspaceID, TabID: "disown"})); err != nil {
		t.Fatalf("kill: %v", err)
	}
	recorder.requireExit(t, "disown", 3*time.Second)
	time.Sleep(hangupGrace + 500*time.Millisecond)
	if processGone(job) {
		t.Fatal("the disowned job ended with its tab")
	}
}

// A shell that does not end on the hangup is killed after hangupGrace, with
// all that is left of its session: it never passed the hangup on.
func TestClosedTabsShellThatIgnoresTheHangupIsKilledWithItsSession(t *testing.T) {
	t.Parallel()
	service, recorder := newTestService(t)
	spawnTestScript(t, service, "deaf", `
trap '' HUP
set -m
sleep 3003 &
echo "BG=$!"
echo READY
wait
`)
	recorder.requireTranscriptContains(t, "READY", 2*time.Second)
	match := backgroundPID.FindStringSubmatch(recorder.transcript())
	if match == nil {
		t.Fatalf("no background job:\n%s", recorder.transcript())
	}
	job, _ := strconv.Atoi(match[1])
	t.Cleanup(func() { _ = syscall.Kill(job, syscall.SIGKILL) })

	if _, err := service.Kill(context.Background(), mustJSON(t, KillParams{WorkspaceID: testWorkspaceID, TabID: "deaf"})); err != nil {
		t.Fatalf("kill: %v", err)
	}
	recorder.requireExit(t, "deaf", hangupGrace+3*time.Second)
	requireGone(t, job, 3*time.Second, "the job of a shell that ignored the hangup")
}

// Closing every tab at once — the daemon shutting down — waits for the
// shells to hang up their jobs, and kills what does not end in time.
func TestServiceCloseHangsUpEveryShell(t *testing.T) {
	t.Parallel()
	service, recorder := newTestService(t)
	spawnInteractiveBash(t, service, "bash", filepath.Join(t.TempDir(), "history"))
	job := startBackgroundJob(t, service, recorder, "bash", "sleep 3004 & echo BG=$!")
	spawnTestScript(t, service, "deaf", `
trap '' HUP
echo READY
while :; do sleep 1; done
`)
	recorder.requireTranscriptContains(t, "READY", 2*time.Second)

	began := time.Now()
	service.Close()
	if took := time.Since(began); took > hangupGrace+2*time.Second {
		t.Fatalf("Close took %v", took)
	}
	requireGone(t, job, 2*time.Second, "the background job")
}

// zombieChildren lists this process's children that ended and were never
// waited for.
func zombieChildren(t *testing.T) []string {
	t.Helper()
	out, err := exec.Command("ps", "-A", "-o", "pid=,ppid=,stat=").Output()
	if err != nil {
		t.Fatalf("ps: %v", err)
	}
	self := strconv.Itoa(os.Getpid())
	var zombies []string
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 3 && fields[1] == self && strings.HasPrefix(fields[2], "Z") {
			zombies = append(zombies, fields[0])
		}
	}
	return zombies
}

// Two spawns of one tab racing each other start two shells; the one that
// loses is killed, and must be waited for too or it stays a zombie of the
// daemon. Not parallel: other tests' shells are briefly zombies as they end.
func TestRacingSpawnsOfATabLeaveNoZombie(t *testing.T) {
	service, _ := newTestService(t)
	for i := 0; i < 5; i++ {
		params := mustJSON(t, SpawnParams{
			WorkspaceID: testWorkspaceID, TabID: fmt.Sprintf("race-%d", i), Cwd: t.TempDir(),
			Shell: "/bin/sh", Args: []string{"-c", "sleep 30"}, Cols: 80, Rows: 24,
		})
		start := make(chan struct{})
		var wg sync.WaitGroup
		for j := 0; j < 2; j++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				if _, err := service.Spawn(context.Background(), params); err != nil {
					t.Errorf("spawn: %v", err)
				}
			}()
		}
		close(start)
		wg.Wait()
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		zombies := zombieChildren(t)
		if len(zombies) == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("shells never waited for: %v", zombies)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// A kill that reaches the agent before the spawn it followed — each request
// runs on a goroutine of its own, and a spawn takes a fork and exec — still
// ends that tab's shell once it starts. The next spawn of the tab is not
// affected.
func TestKillAheadOfItsSpawnStillEndsTheShell(t *testing.T) {
	t.Parallel()
	service, recorder := newTestService(t)
	kill := mustJSON(t, KillParams{WorkspaceID: testWorkspaceID, TabID: "early"})
	if _, err := service.Kill(context.Background(), kill); err != nil {
		t.Fatalf("kill: %v", err)
	}
	spawnTestScript(t, service, "early", "sleep 30\n")
	recorder.requireExit(t, "early", 3*time.Second)

	spawnTestScript(t, service, "early", "echo AGAIN\nsleep 30\n")
	recorder.requireTranscriptContains(t, "AGAIN", 2*time.Second)
	if exits := recorder.exitCount("early"); exits != 1 {
		t.Fatalf("the tab's second shell exited too (%d exits)", exits)
	}
}

// exitCount is how many exit events tabID got.
func (r *eventRecorder) exitCount(tabID string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	count := 0
	for _, exit := range r.exits {
		if exit.TabID == tabID {
			count++
		}
	}
	return count
}
