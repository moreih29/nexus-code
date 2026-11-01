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

// TestListenerHelper is the child TestFindSeesAChildsListener starts: it
// listens on a port below the dynamic range, prints it, and holds it until
// its stdin closes.
func TestListenerHelper(t *testing.T) {
	if os.Getenv(listenerHelperEnv) != "1" {
		t.Skip("run by TestFindSeesAChildsListener")
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

func TestFindSeesAChildsListener(t *testing.T) {
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" && runtime.GOOS != "windows" {
		t.Skip("Find is not available here")
	}
	child := exec.Command(os.Args[0], "-test.run=^TestListenerHelper$")
	child.Env = append(os.Environ(), listenerHelperEnv+"=1")
	stdin, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = stdin.Close()
		_ = child.Wait()
	})
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil {
		t.Fatalf("reading the helper's port: %v", err)
	}
	port, err := strconv.Atoi(strings.TrimSpace(line))
	if err != nil {
		t.Fatalf("the helper printed %q", line)
	}

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
				if p.PID != child.Process.Pid || p.Root != root {
					t.Fatalf("Find() = %+v, want port %d held by %d under %d", p, port, child.Process.Pid, root)
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

// BenchmarkFind measures one look at a small process tree, the test's own:
// the cost is mostly listing every process on the machine.
func BenchmarkFind(b *testing.B) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		b.Fatal(err)
	}
	defer listener.Close()
	roots := []int{os.Getpid()}
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
