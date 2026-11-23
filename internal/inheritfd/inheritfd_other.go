//go:build !unix

package inheritfd

func CloseOnExec() {}
