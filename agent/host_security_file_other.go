//go:build !linux

package main

import "os"

func openSecurityFile(path string) (*os.File, error) {
	return os.Open(path)
}
