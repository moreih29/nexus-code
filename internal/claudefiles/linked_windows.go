package claudefiles

import (
	"os"
	"syscall"
)

func linked(file *os.File, _ os.FileInfo) bool {
	var data syscall.ByHandleFileInformation
	if syscall.GetFileInformationByHandle(syscall.Handle(file.Fd()), &data) != nil {
		return true
	}
	return data.NumberOfLinks > 1
}
