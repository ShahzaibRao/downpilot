//go:build windows

package fetch

import (
	"os/exec"
	"syscall"
)

// hideWindow hides the child process console window
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
