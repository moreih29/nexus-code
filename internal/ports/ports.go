// Package ports finds the TCP ports that programs started in the app's
// terminals listen on — a dev server's — so the app can show and open them.
// It looks rather than assigns: a program keeps whatever port it picked.
package ports

import "sort"

// FirstDynamicPort is where the ports the system hands out on request begin
// (IANA's dynamic range). Programs listen there for their own plumbing, a
// debugger or an editor bridge, not for the user to open, so those ports are
// left out.
const FirstDynamicPort = 49152

// Listener is a TCP port a process listens on.
type Listener struct {
	Port int
	PID  int
}

// Process is a running process as the process table lists it.
type Process struct {
	PPID int
	// Name is the program's file name, without its folder.
	Name string
}

// Port is a listening port held by a process under one of the roots.
type Port struct {
	Port int
	PID  int
	// Name is the program holding the port.
	Name string
	// Root is the root the program is under.
	Root int
}

// under maps each process under the roots, and each root, to its root.
func under(table map[int]Process, roots []int) map[int]int {
	children := make(map[int][]int, len(table))
	for pid, process := range table {
		if pid != process.PPID {
			children[process.PPID] = append(children[process.PPID], pid)
		}
	}
	owner := make(map[int]int)
	for _, root := range roots {
		if _, ok := table[root]; !ok {
			continue
		}
		stack := []int{root}
		for len(stack) > 0 {
			pid := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if _, seen := owner[pid]; seen {
				continue
			}
			owner[pid] = root
			stack = append(stack, children[pid]...)
		}
	}
	return owner
}

// onlyShells reports whether owner holds nothing but the roots: every
// terminal at its prompt, which is most looks. The sockets are not read
// then, the slower half of a look. The cost is a port a shell holds itself,
// as after "exec server", which shows only once something runs under it.
func onlyShells(owner map[int]int) bool {
	for pid, root := range owner {
		if pid != root {
			return false
		}
	}
	return true
}

// match keeps the listeners of the processes owner has, one per port and
// below FirstDynamicPort, in port order. A port held twice, for IPv4 and
// IPv6 or by a server's workers, goes to its lowest process id.
func match(listeners []Listener, table map[int]Process, owner map[int]int) []Port {
	sorted := append([]Listener(nil), listeners...)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].Port != sorted[j].Port {
			return sorted[i].Port < sorted[j].Port
		}
		return sorted[i].PID < sorted[j].PID
	})
	var ports []Port
	for _, listener := range sorted {
		root, ok := owner[listener.PID]
		if !ok || listener.Port <= 0 || listener.Port >= FirstDynamicPort {
			continue
		}
		if n := len(ports); n > 0 && ports[n-1].Port == listener.Port {
			continue
		}
		ports = append(ports, Port{
			Port: listener.Port,
			PID:  listener.PID,
			Name: table[listener.PID].Name,
			Root: root,
		})
	}
	return ports
}
