package process

import "bytes"

// SplitPIDStat splits a Linux /proc/<pid>/stat record into its command name
// and the fields beginning with state. The name may contain spaces and
// parentheses, so the last closing parenthesis ends it. Callers interested
// in the fields alone can still read them if the opening parenthesis is absent.
func SplitPIDStat(data []byte) (name, fields []byte) {
	end := bytes.LastIndexByte(data, ')')
	if end < 0 {
		return nil, nil
	}
	if start := bytes.IndexByte(data[:end], '('); start >= 0 {
		name = data[start+1 : end]
	}
	return name, data[end+1:]
}
