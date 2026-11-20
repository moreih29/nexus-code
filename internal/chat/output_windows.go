//go:build windows

package chat

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

var procMultiByteToWideChar = windows.NewLazySystemDLL("kernel32.dll").NewProc("MultiByteToWideChar")
var procGetOEMCP = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetOEMCP")

// decodeLegacyCodePage reads b as the OEM code page, then the ANSI one.
func decodeLegacyCodePage(b []byte) (string, bool) {
	if len(b) == 0 {
		return "", false
	}
	pages := []uint32{windows.GetACP()}
	if oem, _, _ := procGetOEMCP.Call(); oem != 0 {
		pages = append([]uint32{uint32(oem)}, pages...)
	}
	for _, page := range pages {
		if s, ok := multiByteToUTF8(page, b); ok {
			return s, true
		}
	}
	return "", false
}

func multiByteToUTF8(page uint32, b []byte) (string, bool) {
	if len(b) > 1<<30 {
		return "", false
	}
	// Flags 0 keeps best-fit mapping; invalid sequences become U+FFFD.
	n, _, _ := procMultiByteToWideChar.Call(uintptr(page), 0,
		uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)), 0, 0)
	if n == 0 {
		return "", false
	}
	wide := make([]uint16, n)
	got, _, _ := procMultiByteToWideChar.Call(uintptr(page), 0,
		uintptr(unsafe.Pointer(&b[0])), uintptr(len(b)),
		uintptr(unsafe.Pointer(&wide[0])), n)
	if got == 0 {
		return "", false
	}
	return windows.UTF16ToString(wide[:got]), true
}
