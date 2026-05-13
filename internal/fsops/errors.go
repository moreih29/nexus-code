package fsops

// Error codes carried in the NDJSON error frame for fs.* methods.
// Mirrors `src/shared/protocol/agent/errors.ts`.
//
// The first six codes already appear inline inside `fsops.go` (in
// mapPathError, ReadFile, and Resolve) and are promoted to named
// constants here so the write handlers added in Round 1 reference the
// same identifiers. The last four are net-new for write operations.
const (
	// Existing read-path codes.
	CodeNotFound         = "NOT_FOUND"
	CodePermissionDenied = "PERMISSION_DENIED"
	CodeAlreadyExists    = "ALREADY_EXISTS"
	CodeIsDirectory      = "IS_DIRECTORY"
	CodeTooLarge         = "TOO_LARGE"
	CodeOutOfWorkspace   = "OUT_OF_WORKSPACE"

	// New for fs.writeFile / fs.rmdir / fs.rename.
	CodeStale       = "STALE"        // expected mismatch (optimistic concurrency)
	CodeNotEmpty    = "NOT_EMPTY"    // rmdir against non-empty directory
	CodeCrossDevice = "CROSS_DEVICE" // rename across filesystems (EXDEV)
	CodeNoSpace     = "NO_SPACE"     // disk full during writeFile (ENOSPC)
)
