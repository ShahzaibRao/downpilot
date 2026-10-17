package runtime

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ShahzaibRao/downpilot/backend/internal/probe"
)

// Write an executable fake binary that prints the given version
func fakeBinary(t *testing.T, dir, name, output string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, name)
	// shell scripts can't run on Windows — fall back to .bat
	if runtime.GOOS == "windows" {
		path = filepath.Join(dir, name+".bat")
		if err := os.WriteFile(path, []byte("@echo "+output+"\r\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		return path
	}
	script := "#!/bin/sh\necho '" + output + "'\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestBinaryNameSuffix(t *testing.T) {
	got := BinaryName(KindYtDlp)
	want := "yt-dlp"
	if runtime.GOOS == "windows" {
		want = "yt-dlp.exe"
	}
	if got != want {
		t.Errorf("BinaryName = %q, expected %q", got, want)
	}
}

// the managed dir must beat the system PATH: right after downloading, the new version should be used
func TestManagedDirTakesPrecedenceInCandidates(t *testing.T) {
	managed := t.TempDir()
	list := candidatesFor(KindYtDlp, Options{ManagedDir: managed})

	if len(list) == 0 {
		t.Fatal("candidate list should not be empty")
	}
	wantPath := filepath.Join(managed, BinaryName(KindYtDlp))
	if filepath.Clean(list[0].Path) != filepath.Clean(wantPath) {
		t.Errorf("first candidate should be the managed dir %q, got %q", wantPath, list[0].Path)
	}
	if list[0].Source != SourceManaged {
		t.Errorf("first candidate source should be managed, got %q", list[0].Source)
	}
}

// manual specification must come before all other sources
func TestManualPathWins(t *testing.T) {
	managed := t.TempDir()
	manual := filepath.Join(t.TempDir(), BinaryName(KindFFmpeg))
	list := candidatesFor(KindFFmpeg, Options{
		ManagedDir:  managed,
		ManualPaths: map[Kind]string{KindFFmpeg: manual},
	})

	if filepath.Clean(list[0].Path) != filepath.Clean(manual) {
		t.Errorf("first candidate should be the manual path %q, got %q", manual, list[0].Path)
	}
	if list[0].Source != SourceManual {
		t.Errorf("first candidate source should be manual, got %q", list[0].Source)
	}
}

// candidate paths must be deduped, so one file isn't probed twice
func TestCandidatesDeduplicated(t *testing.T) {
	managed := t.TempDir()
	list := candidatesFor(KindFFmpeg, Options{ManagedDir: managed})
	seen := map[string]int{}
	for _, c := range list {
		seen[filepath.Clean(c.Path)]++
	}
	for path, count := range seen {
		if count > 1 {
			t.Errorf("path %q appears %d times", path, count)
		}
	}
}

func TestFindAllCoversEveryKind(t *testing.T) {
	results := FindAll(Options{ManagedDir: t.TempDir()})
	if len(results) != len(Kinds) {
		t.Fatalf("should return %d results, got %d", len(Kinds), len(results))
	}
	for _, r := range results {
		if r.Kind == "" {
			t.Error("result is missing the kind field")
		}
		// the UI needs something to show whether found or not
		if r.Found && r.Version == "" {
			t.Errorf("%s was found but has no version", r.Kind)
		}
		if !r.Found && r.Reason == "" {
			t.Errorf("%s must give a reason when not found", r.Kind)
		}
	}
}

// a broken binary in the managed dir must not be adopted, let alone fail the whole detection
func TestBrokenManagedBinaryIsSkipped(t *testing.T) {
	managed := t.TempDir()
	broken := filepath.Join(managed, BinaryName(KindYtDlp))
	if err := os.WriteFile(broken, []byte("not a real executable"), 0o755); err != nil {
		t.Fatal(err)
	}

	res := FindOne(KindYtDlp, Options{ManagedDir: managed})
	if res.Found && filepath.Clean(res.Path) == filepath.Clean(broken) {
		t.Error("a broken managed binary should not be judged usable")
	}
	// when the system has yt-dlp, fall back to the system copy; otherwise give a reason
	if !res.Found && res.Reason == "" {
		t.Error("fallback failure must explain why")
	}
}

// a non-executable managed file should be skipped, not abort the detection
func TestNonExecutableManagedBinaryIsSkipped(t *testing.T) {
	managed := t.TempDir()
	noExec := filepath.Join(managed, BinaryName(KindFFmpeg))
	if err := os.WriteFile(noExec, []byte("#!/bin/sh\necho 6.0\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	res := FindOne(KindFFmpeg, Options{ManagedDir: managed})
	if res.Found && filepath.Clean(res.Path) == filepath.Clean(noExec) {
		t.Error("a file without execute permission should not be adopted")
	}
}

// results must carry the source, so the UI can tell "system install" from "downloaded by DownPilot"
func TestResultCarriesSource(t *testing.T) {
	managed := t.TempDir()
	_ = fakeBinary(t, managed, BinaryName(KindYtDlp), "2026.10.10")

	res := FindOne(KindYtDlp, Options{ManagedDir: managed})
	if !res.Found {
		t.Skipf("test script cannot run on this platform: %s", res.Reason)
	}
	if res.Path == "" || res.Source == "" {
		t.Errorf("a found dependency must include path and source, got %+v", res)
	}
	if res.Source != string(SourceManaged) {
		t.Errorf("managed binary source should be managed, got %q", res.Source)
	}
	if !res.Managed {
		t.Error("deps in the managed dir should be marked managed=true")
	}
}

// optional deps must be marked, so the UI knows whether to block the user
func TestFfprobeIsOptional(t *testing.T) {
	if !Optional[KindFFprobe] {
		t.Error("ffprobe should be marked as an optional dependency")
	}
	if Optional[KindYtDlp] || Optional[KindFFmpeg] {
		t.Error("yt-dlp and ffmpeg are required deps and should not be marked optional")
	}
}

func TestSystemDirsExcludesAsar(t *testing.T) {
	for _, dir := range systemDirs() {
		if filepath.Base(dir) == "app.asar" || len(dir) > 0 && filepath.Base(filepath.Dir(dir)) == "app.asar" {
			t.Errorf("common dirs should not include app.asar: %q", dir)
		}
	}
}

// TestSlowManagedBinaryIsStillAdopted regression: the UI still said "download" after downloading.
//
// The user clicked "download" → progress finished → the UI **still said "download"**, and re-clicking did nothing.
// The root cause wasn't the download but the post-download re-read: yt-dlp's official macOS build (PyInstaller,
// ~37MB) needs 8-10s for `--version`, while probing one candidate once had only a 3s budget,
// so the just-installed managed copy was judged "execution timed out, the file may be corrupt" and skipped.
//
// Here the managed copy is "slow to start but correct"; assert it's still adopted — shrinking the budget to 3s fails this.
func TestSlowManagedBinaryIsStillAdopted(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("slow startup cannot be simulated with a shell script on Windows")
	}
	if testing.Short() {
		t.Skip("needs real waiting, skipped in short mode")
	}
	managed := t.TempDir()
	slow := filepath.Join(managed, BinaryName(KindYtDlp))
	script := "#!/bin/sh\nsleep 6\necho '2026.10.10.233141'\n"
	if err := os.WriteFile(slow, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	res := FindOne(KindYtDlp, Options{ManagedDir: managed})
	if !res.Found {
		t.Fatalf("a slow-but-healthy managed copy should be adopted, but was not found: %s", res.Reason)
	}
	if filepath.Clean(res.Path) != filepath.Clean(slow) {
		t.Errorf("should adopt the managed copy %q, got %q", slow, res.Path)
	}
	if res.Source != string(SourceManaged) || !res.Managed {
		t.Errorf("source should be managed and Managed=true, got source=%q managed=%v", res.Source, res.Managed)
	}
	if res.Version != "2026.10.10.233141" {
		t.Errorf("version = %q, expected 2026.10.10.233141", res.Version)
	}
}

// TestScanTimeLimitOutlastsOneCandidate: the scan deadline must fit one slow candidate.
//
// Otherwise the fallback scan gets cut off on its first hit (possibly the just-downloaded managed copy),
// and the old "installed but reported missing" bug reappears somewhere else.
func TestScanTimeLimitOutlastsOneCandidate(t *testing.T) {
	if scanTimeLimit <= probe.CandidateTimeout {
		t.Fatalf("scanTimeLimit = %s must be > probe.CandidateTimeout = %s, "+
			"or the scan cannot even finish one slow candidate", scanTimeLimit, probe.CandidateTimeout)
	}
}

// TestHangingSystemCandidatesDoNotStarveGoodCopy: regression for the design flaw the Windows case exposed.
//
// The old fix for slow startups was "retry once after timeout", which made each **stuck** candidate cost 30s
// (15s × 2) — two stuck candidates ate a whole dependency's budget, and the healthy copy
// behind them never got a turn — this is exactly how CI's windows job failed (the healthy copy
// came after two stuck candidates). The right fix is **different budgets per source**: generous for the
// managed copy, short for system copies, and stuck ones give up early.
func TestHangingSystemCandidatesDoNotStarveGoodCopy(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("slow startup cannot be simulated with a shell script on Windows")
	}
	if testing.Short() {
		t.Skip("needs real waiting, skipped in short mode")
	}
	// Setup: empty managed dir → two stuck candidates on PATH → third one healthy
	managed := t.TempDir()
	dirs := []string{t.TempDir(), t.TempDir(), t.TempDir()}
	for _, dir := range dirs[:2] {
		hang := filepath.Join(dir, BinaryName(KindYtDlp))
		if err := os.WriteFile(hang, []byte("#!/bin/sh\nsleep 300\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	_ = fakeBinary(t, dirs[2], BinaryName(KindYtDlp), "2026.10.10.233141")

	// **The original PATH must be kept**: replacing PATH wholesale with a temp dir means the fake
	// binary's `sleep` can no longer be found, so the script exits immediately with "command not found" —
	// turning this case into a no-op (measured 0.67s total, never actually waited out a timeout),
	// while it's supposed to verify that "stuck candidates get abandoned on the short budget".
	t.Setenv("PATH", strings.Join(append(dirs, os.Getenv("PATH")), string(os.PathListSeparator)))

	start := time.Now()
	res := FindOne(KindYtDlp, Options{ManagedDir: managed})
	elapsed := time.Since(start)

	if !res.Found {
		t.Fatalf("the healthy copy after stuck candidates should be adopted, got: %s", res.Reason)
	}
	if res.Version != "2026.10.10.233141" {
		t.Errorf("version = %q, expected 2026.10.10.233141", res.Version)
	}
	// two stuck candidates × 5s budget + 2s WaitDelay each + the healthy copy,
	// capped at 20s; if system candidates wrongly used the 15s budget, this would exceed 30s.
	if elapsed > 20*time.Second {
		t.Errorf("detection took %s — the short budget for system candidates did not apply", elapsed)
	}
	t.Logf("two stuck candidates + healthy copy took %s", elapsed)
}

// TestProbeBudgetResets: the candidate-execution budget must be reset before each detection.
//
// It's package-level mutable state; without a reset, "the previous detection spent the budget" makes the next
// one silently do nothing — the same pitfall as the scan budget.
func TestProbeBudgetResets(t *testing.T) {
	probeDeadline = time.Now().Add(-time.Second) // pretend the previous run spent it
	if !probeBudgetExhausted() {
		t.Fatal("an expired budget should count as spent")
	}
	resetProbeBudget()
	if probeBudgetExhausted() {
		t.Fatal("should not count as spent after reset")
	}
	probeDeadline = time.Time{} // zero means no deadline
	if probeBudgetExhausted() {
		t.Fatal("zero should mean no deadline, otherwise detection silently does nothing")
	}
}

// TestProbeTimeoutDetection: only timeouts get retried; other errors shouldn't waste a candidate budget
func TestProbeTimeoutDetection(t *testing.T) {
	cases := map[string]bool{
		"execution timed out (the executable responded too slowly \u2014 it may be corrupt, or just slow on first run)": true,
		"execution timed out": false, // asserted separately below: anything containing the marker counts as timeout
		"cannot execute (the macOS build may be corrupt or unsigned; re-download it)": false,
		"bad file format (the download may be incomplete or built for another CPU architecture); re-download it": false,
		"no execute permission (chmod +x)": false,
	}
	for msg, want := range cases {
		got := isProbeTimeout(errors.New(msg))
		if msg == "execution timed out" {
			if !got {
				t.Errorf("%q should be judged a timeout", msg)
			}
			continue
		}
		if got != want {
			t.Errorf("isProbeTimeout(%q) = %v, expected %v", msg, got, want)
		}
	}
	if isProbeTimeout(nil) {
		t.Error("nil should not be judged a timeout")
	}
}
