//go:build !unix

package inheritfd

// CloseOnExec does nothing where descriptors are not inherited by default.
func CloseOnExec() {}
