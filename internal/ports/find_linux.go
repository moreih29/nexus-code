//go:build linux

package ports

import (
	"os"
	"strconv"
)

func Find(roots []int) ([]Port, error) {
	table, err := processTable()
	if err != nil {
		return nil, err
	}
	owner := under(table, roots)
	if onlyShells(owner) {
		return nil, nil
	}
	byInode := map[uint64]int{}
	for _, path := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
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
