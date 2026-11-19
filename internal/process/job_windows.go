//go:build windows

package process

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

// AssignJob creates a job and assigns pid to it. The caller owns the returned
// handle. A job with killOnClose ends its remaining processes when released.
func AssignJob(pid int, killOnClose bool) (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	// Neither policy permits breakaway. Git Bash would start its programs
	// outside the job if it were allowed to.
	if killOnClose {
		var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
		info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
		if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
			_ = windows.CloseHandle(job)
			return 0, err
		}
	}
	target, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		_ = windows.CloseHandle(job)
		return 0, err
	}
	defer windows.CloseHandle(target)
	if err := windows.AssignProcessToJobObject(job, target); err != nil {
		_ = windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}
