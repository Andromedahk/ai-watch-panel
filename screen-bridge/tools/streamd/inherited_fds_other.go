//go:build !linux

package main

// Host builds exist for protocol tests only. The daemon runs on Linux/ARM64.
func closeInheritedGadgetFds() {}
