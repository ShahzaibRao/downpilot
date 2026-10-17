package manifest

import (
	"path/filepath"
	"strings"
	"testing"
)

// Directly verify the task generation for issue #40's command line
func TestIssue40Repro(t *testing.T) {
	// dp-deps.exe fetch --managed-dir C:\Users\x\AppData\Roaming\downpilot\runtime\bin --only ffmpeg
	tasks, err := TasksFor("win32/x64", `C:\Users\x\AppData\Roaming\downpilot\runtime\bin`, []string{"ffmpeg"})
	if err != nil {
		t.Fatalf("issue #40 scenario still errors: %v", err)
	}
	if len(tasks) != 1 {
		t.Fatalf("should generate exactly one ffmpeg task, got %d", len(tasks))
	}
	task := tasks[0]
	if task.Tool != "ffmpeg" {
		t.Errorf("tool should be ffmpeg, got %q", task.Tool)
	}
	if task.URL == "" || task.SHA256 == "" {
		t.Error("task is missing download URL or checksum")
	}
	// Paths are joined with filepath.Join, so separators follow the **host** platform — on macOS
	// you get mixed forms like `C:\...\bin/ffmpeg`, while real Windows uses backslashes.
	// So only assert the trailing file name here, never a hard-coded separator (that would fail on the other platform).
	// BinaryName also follows the host platform ("ffmpeg" on macOS, "ffmpeg.exe" on Windows),
	// so compare via filepath.Base to keep platform differences out of the assertion.
	if base := filepath.Base(task.Target); !strings.HasPrefix(base, "ffmpeg") {
		t.Errorf("target path file name should start with ffmpeg, got %q", base)
	}
	t.Logf("generated task: %s → %s", task.URL, task.Target)
}
