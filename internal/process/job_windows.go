//go:build windows

package process

import (
	"errors"
	"os"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

func AssignJob(pid int, killOnClose bool) (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
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

func ResumeSuspended(pid uint32) error {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPTHREAD, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snapshot)
	var entry windows.ThreadEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	for err := windows.Thread32First(snapshot, &entry); err == nil; err = windows.Thread32Next(snapshot, &entry) {
		if entry.OwnerProcessID != pid {
			continue
		}
		thread, err := windows.OpenThread(windows.THREAD_SUSPEND_RESUME, false, entry.ThreadID)
		if err != nil {
			return err
		}
		defer windows.CloseHandle(thread)
		_, err = windows.ResumeThread(thread)
		return err
	}
	return os.ErrProcessDone
}

func TerminateJobAndWait(job windows.Handle, timeout time.Duration) error {
	pids, listErr := jobProcessIDs(job)
	var handles []windows.Handle
	var openErr error
	for _, pid := range pids {
		process, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			continue
		}
		if err != nil {
			openErr = errors.Join(openErr, err)
			continue
		}
		handles = append(handles, process)
	}
	defer func() {
		for _, process := range handles {
			_ = windows.CloseHandle(process)
		}
	}()
	if err := windows.TerminateJobObject(job, 1); err != nil {
		return errors.Join(listErr, openErr, err)
	}
	deadline := time.Now().Add(timeout)
	for _, process := range handles {
		remaining := max(0, time.Until(deadline))
		waitMillis := uint32((remaining + time.Millisecond - 1) / time.Millisecond)
		event, err := windows.WaitForSingleObject(process, waitMillis)
		if err != nil {
			return errors.Join(listErr, openErr, err)
		}
		if event == uint32(windows.WAIT_TIMEOUT) {
			return errors.Join(listErr, openErr, os.ErrDeadlineExceeded)
		}
	}
	return errors.Join(listErr, openErr)
}

func jobProcessIDs(job windows.Handle) ([]uintptr, error) {
	const wordSize = int(unsafe.Sizeof(uintptr(0)))
	const headerWords = 8 / wordSize
	for capacity := 16; ; capacity *= 2 {
		words := make([]uintptr, headerWords+capacity)
		header := (*[2]uint32)(unsafe.Pointer(&words[0]))
		err := windows.QueryInformationJobObject(job, windows.JobObjectBasicProcessIdList,
			uintptr(unsafe.Pointer(&words[0])), uint32(len(words)*wordSize), nil)
		if errors.Is(err, windows.ERROR_MORE_DATA) {
			continue
		}
		if err != nil {
			return nil, err
		}
		return words[headerWords : headerWords+int(header[1])], nil
	}
}
