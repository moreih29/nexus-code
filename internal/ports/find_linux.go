//go:build linux

package ports

import (
	"os"
	"strconv"
)

// Find lists the ports the processes under roots listen on: /proc gives the
// process tree, /proc/net/tcp and tcp6 the listening sockets by inode, and
// each process's fd links which of those it holds.
func Find(roots []int) ([]Port, error) {
	table, err := processTable()
	if err != nil {
		return nil, err
	}
	owner := under(table, roots)
	// Terminals at their prompt hold no ports: see onlyShells.
	if onlyShells(owner) {
		return nil, nil
	}
	byInode := map[uint64]int{}
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		// tcp6 is missing where IPv6 is off.
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for inode, port := range parseProcNetTCP(data) {
			byInode[inode] = port
		}
	}
	if len(byInode) == 0 {
		return nil, nil
	}
	var listeners []Listener
	for pid := range owner {
		dir := "/proc/" + strconv.Itoa(pid) + "/fd/"
		// Another user's process, or one that has exited, can't be read.
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			link, err := os.Readlink(dir + entry.Name())
			if err != nil {
				continue
			}
			if inode, ok := socketInode(link); ok {
				if port, ok := byInode[inode]; ok {
					listeners = append(listeners, Listener{Port: port, PID: pid})
				}
			}
		}
	}
	return match(listeners, table, owner), nil
}

func processTable() (map[int]Process, error) {
	dirs, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	table := make(map[int]Process, len(dirs))
	for _, dir := range dirs {
		pid, err := strconv.Atoi(dir.Name())
		if err != nil {
			continue
		}
		// A process can exit between the listing and this read.
		data, err := os.ReadFile("/proc/" + dir.Name() + "/stat")
		if err != nil {
			continue
		}
		if process, ok := parseProcStat(data); ok {
			table[pid] = process
		}
	}
	return table, nil
}
