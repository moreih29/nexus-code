//go:build darwin

package chat

import "golang.org/x/sys/unix"

// parents maps each process to its parent, as the kernel lists them.
func parents() map[int]int {
	procs, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil
	}
	table := make(map[int]int, len(procs))
	for _, proc := range procs {
		table[int(proc.Proc.P_pid)] = int(proc.Eproc.Ppid)
	}
	return table
}

// processStart identifies a process by its kernel start timestamp.
func processStart(pid int) uint64 {
	p, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return 0
	}
	return uint64(p.Proc.P_starttime.Sec)*1_000_000 + uint64(p.Proc.P_starttime.Usec)
}
