package proto

import "os"

func ExitStatus(state *os.ProcessState, err error) (code *int, signal *string) {
	exit := -1
	if err == nil && state != nil {
		exit = state.ExitCode()
	}
	return &exit, nil
}
