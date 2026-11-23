//go:build !darwin

package hookclient

func PrintChildHelper([]string) (int, bool) { return 0, false }
