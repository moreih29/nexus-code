//go:build !darwin

package chat

func TrackOwnedPrograms(_, _ string) ([]int, error) {
	return nil, nil
}

func noteOwned(int, uint64) {}

func forgetOwned(int) {}
