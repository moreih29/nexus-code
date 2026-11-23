package ports

import "sort"

const FirstDynamicPort = 49152

type Listener struct {
	Port int
	PID  int
}

type Process struct {
	PPID int
	Name string
}

type Port struct {
	Port int
	PID  int
	Name string
	Root int
}

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

func onlyShells(owner map[int]int) bool {
	for pid, root := range owner {
		if pid != root {
			return false
		}
	}
	return true
}

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
