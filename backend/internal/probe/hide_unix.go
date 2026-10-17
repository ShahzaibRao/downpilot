//go:build !windows

package probe

import "os/exec"

// hideWindow is a no-op on Linux (processes have no console window there)
func hideWindow(_ *exec.Cmd) {}
