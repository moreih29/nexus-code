package content

// BinaryProbeBytes is the prefix inspected to classify a file as binary.
const BinaryProbeBytes = 512

// IsBinaryProbe returns true when the prefix looks like a binary file.
func IsBinaryProbe(probe []byte) bool {
	if len(probe) >= 2 && ((probe[0] == 0xff && probe[1] == 0xfe) || (probe[0] == 0xfe && probe[1] == 0xff)) {
		return true
	}
	for _, b := range probe {
		if b == 0x00 {
			return true
		}
	}
	return false
}
