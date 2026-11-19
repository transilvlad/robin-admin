package main

import (
	"os"
	"syscall"
)

func openSecurityFile(path string) (*os.File, error) {
	file, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	return os.NewFile(uintptr(file), path), nil
}
