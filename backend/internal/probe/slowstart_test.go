package probe

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// slowBinary writes a fake binary that "starts slowly, outputs later", simulating
// yt-dlp's official macOS build (PyInstaller, measured 8-10s for --version on this machine).
//
// What must be slow is the **execution itself**: the case proves "the per-candidate timeout must fit an 8s-class startup",
// so shrinking CandidateTimeout should fail it.
func slowBinary(t *testing.T, dir, name, output string, delay time.Duration) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("slow startup cannot be simulated with a shell script on Windows")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	script := fmt.Sprintf("#!/bin/sh\nsleep %.1f\necho '%s'\n", delay.Seconds(), output)
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestCandidateTimeoutAllowsSlowStartup regression: a just-downloaded yt-dlp was judged "unusable".
//
// Symptom: user clicks "download" → progress finishes → the UI **still says "download"**, and re-clicking never helps.
// Cause: probing one candidate had a 3s budget, but yt-dlp's official macOS build (~37MB,
// PyInstaller-packed) stably needs 8-10s for `--version`, so the timeout was translated to
// "execution timed out, the file may be corrupt", the managed copy got skipped, and the result fell back
// to the system's older copy (or reported missing outright). Homebrew/uv installs are Python zipapps taking 0.2s,
// so only machines that "must use the managed copy" hit this.
//
// This case puts a 6s startup inside the probe: shrinking the budget back to 3s fails it.
func TestCandidateTimeoutAllowsSlowStartup(t *testing.T) {
	if testing.Short() {
		t.Skip("needs real waiting, skipped in short mode")
	}
	path := slowBinary(t, t.TempDir(), "yt-dlp", "2026.10.10.233141", 6*time.Second)

	info, err := Run("yt-dlp", path)
	if err != nil {
		t.Fatalf("a 6s-startup candidate should not be judged unusable (budget %s): %v", CandidateTimeout, err)
	}
	if info.Version != "2026.10.10.233141" {
		t.Errorf("version = %q, expected 2026.10.10.233141", info.Version)
	}
}

// TestCandidateTimeoutIsGreaterThanSlowStartup encodes "the budget must be enough" as an assertion.
//
// Someone hard-coding 3s probably didn't mean it, so block that with a lower-bound constraint:
// if anyone sets CandidateTimeout back to 3s, this fails first and says why.
func TestCandidateTimeoutIsGreaterThanSlowStartup(t *testing.T) {
	const ytDlpWorstCase = 10 * time.Second // measured 8-10s on this machine
	if CandidateTimeout < ytDlpWorstCase {
		t.Fatalf("CandidateTimeout = %s, must be ≥ %s: yt-dlp's official macOS build needs this long for a cold start, "+
			"and a smaller budget makes just-downloaded copies get judged \"corrupt\"", CandidateTimeout, ytDlpWorstCase)
	}
}

// TestTimeoutMessageNotAbsolute: the timeout message must not assert the file "is corrupt".
//
// A user seeing "the file may be corrupt" re-downloads, and the next run times out again — it's exactly this
// misleading wording that made the symptom look like "the download is broken".
//
// Test describeRunError directly: spawning a real process to trigger a timeout is slow and not cross-platform
// (once used /bin/echo, which on Windows reported "executable file not found").
func TestTimeoutMessageNotAbsolute(t *testing.T) {
	msg := describeRunError(context.DeadlineExceeded, "").Error()
	if !strings.Contains(msg, "timed out") {
		t.Errorf("error should mention a timeout, got: %s", msg)
	}
	if strings.Contains(msg, "is corrupt") {
		t.Errorf("must not assert a timeout means \"corrupt\": downloaded files time out too, got: %s", msg)
	}
	// context cancellation (user closed the UI / parent timed out) shares the same wording
	msg2 := describeRunError(context.Canceled, "").Error()
	if !strings.Contains(msg2, "timed out") {
		t.Errorf("context cancellation should also get timeout wording, got: %s", msg2)
	}
}
