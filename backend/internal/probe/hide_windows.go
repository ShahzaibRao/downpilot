//go:build windows

package probe

import (
	"os/exec"
	"syscall"
)

// hideWindow hides the child process console window, so probing doesn't flash a black box
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}
