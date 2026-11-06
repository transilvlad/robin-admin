//go:build !linux && !darwin

package main

import "os"

func logFileIdentity(os.FileInfo) (uint64, uint64) {
	return 0, 0
}
