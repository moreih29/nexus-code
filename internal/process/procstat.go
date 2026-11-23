package process

import "bytes"

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
