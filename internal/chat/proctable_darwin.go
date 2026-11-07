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
