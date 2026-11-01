package ports

import (
	"bufio"
	"fmt"
	"io"
	"math/rand"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

const listenerHelperEnv = "NEXUS_PORTS_TEST_LISTENER"

// TestListenerHelper is the child startListener starts: it listens on a
// port below the dynamic range, prints it, and holds it until its stdin
// closes.
func TestListenerHelper(t *testing.T) {
	if os.Getenv(listenerHelperEnv) != "1" {
		t.Skip("run by startListener")
	}
	for attempt := 0; attempt < 50; attempt++ {
		port := 20000 + rand.Intn(12000)
		listener, err := net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
		if err != nil {
			continue
		}
		fmt.Println(port)
		_, _ = io.Copy(io.Discard, os.Stdin)
		_ = listener.Close()
		return
	}
	t.Fatal("no free port")
}

// startListener starts a child of the test that listens on a port, as a
// dev server under a terminal's shell does, and gives its port and pid.
func startListener(tb testing.TB) (port, pid int) {
	tb.Helper()
	child := exec.Command(os.Args[0], "-test.run=^TestListenerHelper$")
	child.Env = append(os.Environ(), listenerHelperEnv+"=1")
	stdin, err := child.StdinPipe()
	if err != nil {
		tb.Fatal(err)
	}
	stdout, err := child.StdoutPipe()
	if err != nil {
		tb.Fatal(err)
	}
	if err := child.Start(); err != nil {
		tb.Fatal(err)
	}
	tb.Cleanup(func() {
		_ = stdin.Close()
		_ = child.Wait()
	})
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		tb.Fatalf("reading the helper's port: %v", err)
	}
	port, err = strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		tb.Fatalf("the helper printed %q", line)
	}
	return port, child.Process.Pid
}

func TestFindSeesAChildsListener(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" && runtime.GOOS != "windows" {
		t.Skip("Find is not available here")
	}
	port, pid := startListener(t)

	// The test is the helper's root, as a terminal's shell is its programs'.
	root := os.Getpid()
	deadline := time.Now().Add(5 * time.Second)
	for {
		found, err := Find([]int{root})
		if err != nil {
			t.Fatalf("Find() error = %v", err)
		}
		for _, p := range found {
			if p.Port == port {
				if p.PID != pid || p.Root != root {
					t.Fatalf("Find() = %+v, want port %d held by %d under %d", p, port, pid, root)
				}
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("Find() = %+v, missing port %d", found, port)
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// A root with nothing under it is a shell at its prompt, whose sockets are
// not read: the helper, as a root, holds its port unseen. (The test itself
// is no lone root: Find's ps runs under it.) Not on Windows, where a
// console program can have a conhost child of its own.
func TestFindSkipsALoneRootsListener(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skip("a lone root is not certain here")
	}
	_, pid := startListener(t)
	found, err := Find([]int{pid})
	if err != nil || len(found) != 0 {
		t.Fatalf("Find(a lone root) = %+v, %v", found, err)
	}
}

// BenchmarkFind measures one look at a small process tree with a server in
// it, the test's own: the cost is mostly listing every process on the
// machine.
func BenchmarkFind(b *testing.B) {
	startListener(b)
	roots := []int{os.Getpid()}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := Find(roots); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkFindAtThePrompt measures a look at a terminal with nothing
// running in it, the helper as its shell: the process listing alone.
func BenchmarkFindAtThePrompt(b *testing.B) {
	_, pid := startListener(b)
	roots := []int{pid}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := Find(roots); err != nil {
			b.Fatal(err)
		}
	}
}

func TestFindWithNoRootRunningFindsNothing(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" && runtime.GOOS != "windows" {
		t.Skip("Find is not available here")
	}
	found, err := Find([]int{-1})
	if err != nil || len(found) != 0 {
		t.Fatalf("Find(no root running) = %+v, %v", found, err)
	}
}
