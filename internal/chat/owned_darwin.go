//go:build darwin

package chat

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

const (
	orphanEndWait = 3 * time.Second
	zombieState   = 5
)

type ownedIdentity struct {
	PID   int    `json:"pid"`
	Start uint64 `json:"start"`
}

type ownedRecord struct {
	Workspace string          `json:"workspace"`
	Agent     ownedIdentity   `json:"agent"`
	Parent    ownedIdentity   `json:"parent"`
	Programs  []ownedIdentity `json:"programs"`
}

type ownedPrograms struct {
	mu       sync.Mutex
	path     string
	record   ownedRecord
	programs map[int]uint64
}

var owned atomic.Pointer[ownedPrograms]

func TrackOwnedPrograms(dir, workspace string) ([]int, error) {
	parent := runningIdentity(os.Getppid())
	ended := endOrphans(dir, workspace, parent)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return ended, err
	}
	self := runningIdentity(os.Getpid())
	owned.Store(&ownedPrograms{
		path:     filepath.Join(dir, fmt.Sprintf("%s-%d.json", workspace, self.PID)),
		record:   ownedRecord{Workspace: workspace, Agent: self, Parent: parent},
		programs: make(map[int]uint64),
	})
	return ended, nil
}

func noteOwned(pid int, start uint64) {
	if programs := owned.Load(); programs != nil && start != 0 {
		programs.change(func(m map[int]uint64) { m[pid] = start })
	}
}

func forgetOwned(pid int) {
	if programs := owned.Load(); programs != nil {
		programs.change(func(m map[int]uint64) { delete(m, pid) })
	}
}

func (o *ownedPrograms) change(edit func(map[int]uint64)) {
	o.mu.Lock()
	defer o.mu.Unlock()
	edit(o.programs)
	if len(o.programs) == 0 {
		_ = os.Remove(o.path)
		return
	}
	record := o.record
	record.Programs = make([]ownedIdentity, 0, len(o.programs))
	for pid, start := range o.programs {
		record.Programs = append(record.Programs, ownedIdentity{PID: pid, Start: start})
	}
	sort.Slice(record.Programs, func(i, j int) bool { return record.Programs[i].PID < record.Programs[j].PID })
	data, err := json.Marshal(record)
	if err != nil {
		return
	}
	temp := o.path + ".tmp"
	if os.WriteFile(temp, data, 0o600) == nil {
		_ = os.Rename(temp, o.path)
	}
}

func endOrphans(dir, workspace string, parent ownedIdentity) []int {
	paths, _ := filepath.Glob(filepath.Join(dir, workspace+"-*.json"))
	var ended []int
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var record ownedRecord
		if json.Unmarshal(data, &record) != nil || record.Workspace != workspace {
			continue
		}
		if running(record.Agent) || (record.Parent != parent && running(record.Parent)) {
			continue
		}
		ended = append(ended, endPrograms(record.Programs)...)
		_ = os.Remove(path)
	}
	return ended
}

func endPrograms(programs []ownedIdentity) []int {
	var ended []int
	var targets []ownedIdentity
	for _, program := range programs {
		if !running(program) {
			continue
		}
		tree := []ownedIdentity{program}
		for _, child := range descendants(program.PID) {
			if id := runningIdentity(child); id.Start != 0 {
				tree = append(tree, id)
			}
		}
		if pgid, err := unix.Getpgid(program.PID); err == nil && pgid == program.PID && running(program) {
			_ = syscall.Kill(-program.PID, syscall.SIGKILL)
		}
		for _, target := range tree {
			if running(target) {
				_ = syscall.Kill(target.PID, syscall.SIGKILL)
			}
		}
		targets = append(targets, tree...)
		ended = append(ended, program.PID)
	}
	deadline := time.Now().Add(orphanEndWait)
	for _, target := range targets {
		for running(target) && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
	}
	return ended
}

func runningIdentity(pid int) ownedIdentity {
	return ownedIdentity{PID: pid, Start: runningStart(pid)}
}

func running(id ownedIdentity) bool {
	return id.Start != 0 && runningStart(id.PID) == id.Start
}

func runningStart(pid int) uint64 {
	if pid <= 0 {
		return 0
	}
	p, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil || p.Proc.P_pid != int32(pid) || p.Proc.P_stat == zombieState {
		return 0
	}
	return uint64(p.Proc.P_starttime.Sec)*1_000_000 + uint64(p.Proc.P_starttime.Usec)
}
