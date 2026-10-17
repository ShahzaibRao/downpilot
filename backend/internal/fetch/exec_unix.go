//go:build !windows

package fetch

import "os/exec"

// hideWindow is a no-op on Unix-like systems
func hideWindow(_ *exec.Cmd) {}
