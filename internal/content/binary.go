package content

const BinaryProbeBytes = 512

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
