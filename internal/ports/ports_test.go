package ports

import (
	"reflect"
	"testing"
)

func TestMatchKeepsPortsOfProcessesUnderTheRoots(t *testing.T) {
	table := map[int]Process{
		1:   {PPID: 0, Name: "init"},
		100: {PPID: 1, Name: "zsh"},    // a terminal's shell
		110: {PPID: 100, Name: "bun"},  // bun dev
		111: {PPID: 110, Name: "node"}, // the server it runs
		112: {PPID: 111, Name: "esbuild"},
		200: {PPID: 1, Name: "zsh"}, // another terminal's shell
		210: {PPID: 200, Name: "python3"},
		300: {PPID: 1, Name: "postgres"}, // started elsewhere
	}
	listeners := []Listener{
		{Port: 5173, PID: 111},
		{Port: 5173, PID: 111}, // IPv6 too
		{Port: 8000, PID: 210},
		{Port: 5432, PID: 300},
		{Port: 51234, PID: 112}, // a port the system handed out
	}

	got := match(listeners, table, under(table, []int{100, 200}))
	want := []Port{
		{Port: 5173, PID: 111, Name: "node", Root: 100},
		{Port: 8000, PID: 210, Name: "python3", Root: 200},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("match() = %+v, want %+v", got, want)
	}
}

func TestMatchGivesASharedPortToItsLowestProcess(t *testing.T) {
	table := map[int]Process{
		100: {PPID: 1, Name: "zsh"},
		120: {PPID: 100, Name: "worker"},
		110: {PPID: 100, Name: "server"},
	}
	listeners := []Listener{{Port: 3000, PID: 120}, {Port: 3000, PID: 110}}

	got := match(listeners, table, under(table, []int{100}))
	if len(got) != 1 || got[0].PID != 110 {
		t.Fatalf("match() = %+v, want port 3000 held by 110", got)
	}
}

func TestOnlyShells(t *testing.T) {
	if !onlyShells(map[int]int{}) || !onlyShells(map[int]int{100: 100, 200: 200}) {
		t.Fatal("onlyShells(roots alone) = false")
	}
	if onlyShells(map[int]int{100: 100, 101: 100}) {
		t.Fatal("onlyShells(a program under a root) = true")
	}
}

func TestUnderSkipsRootsThatAreNotRunning(t *testing.T) {
	table := map[int]Process{100: {PPID: 1, Name: "zsh"}, 101: {PPID: 100, Name: "vim"}}

	got := under(table, []int{100, 999})
	if want := map[int]int{100: 100, 101: 100}; !reflect.DeepEqual(got, want) {
		t.Fatalf("under() = %v, want %v", got, want)
	}
}
