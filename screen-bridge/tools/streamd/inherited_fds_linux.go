package main

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// Drop printer handles inherited from the vendor Console shell before opening
// the gadget ourselves; leaving one open makes the exclusive open fail.
func closeInheritedGadgetFds() {
	ents, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return
	}
	for _, e := range ents {
		fd, err := strconv.Atoi(e.Name())
		if err != nil || fd < 3 {
			continue
		}
		t, err := os.Readlink("/proc/self/fd/" + e.Name())
		if err == nil && strings.Contains(t, "g_printer") {
			_ = syscall.Close(fd)
			logf2("closed inherited fd %d -> %s", fd, t)
		}
	}
}
