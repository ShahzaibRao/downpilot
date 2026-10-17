package runtime

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ShahzaibRao/downpilot/backend/internal/probe"
)

// Windows candidate dirs must be verifiable **on macOS**.
//
// Regression background: winget-installed deps were previously undetectable because candidates only covered
// WinGet\Links (portable packages' symlinks), missing the actually-extracted dirs under WinGet\Packages.
// This machine is macOS; reading os.UserHomeDir directly would only ever show macOS paths,
// so this gap could never be caught locally.
func TestWindowsInstallDirsCoverWinget(t *testing.T) {
	home := `C:\Users\tester`
	dirs := windowsInstallDirs(home)

	// Normalize separators before asserting: filepath.Join follows the **host** platform, so on macOS
	// it produces forward slashes — hard-coding backslashes fails the case locally (a repeatedly-hit pitfall).
	joined := strings.ReplaceAll(strings.Join(dirs, "\n"), "\\", "/")

	// Only assert **static** dirs. Paths under Packages contain random hashes and don't exist locally;
	// asserting expansion results would be asserting the environment; their patterns are covered by TestWindowsPackagePatternsCoverWinget.
	must := []struct{ path, why string }{
		{"WinGet/Links", "yt-dlp.yt-dlp is a portable package; its symlink lands here"},
		{"scoop/shims", "scoop's symlink dir"},
		{"chocolatey/bin", "choco's symlink dir"},
		{"WindowsApps", "Microsoft Store apps alias dir"},
	}
	for _, m := range must {
		if !strings.Contains(joined, m.path) {
			t.Errorf("candidate dirs are missing %s (%s)", m.path, m.why)
		}
	}
}

func TestWindowsInstallDirsUseGivenHome(t *testing.T) {
	home := `D:\Users\someone`
	dirs := windowsInstallDirs(home)
	// paths built with filepath.Join should be based on the given home, not the current user's
	found := false
	for _, d := range dirs {
		if strings.Contains(d, "D:") && strings.Contains(d, "someone") {
			found = true
		}
		if strings.Contains(d, "/Users/mac") {
			t.Errorf("host user dir should not appear: %s", d)
		}
	}
	if !found {
		t.Error("paths were not generated from the given home")
	}
}

// Wildcard patterns are **data**, so their correctness can be asserted on macOS.
//
// The old code inlined the patterns in windowsInstallDirs, but filepath.Glob on macOS
// inevitably returns empty for Windows paths, so cases only ever saw "empty result" — untested; injecting
// a mutation (deleting a pattern) would not fail either.
func TestWindowsPackagePatternsCoverWinget(t *testing.T) {
	joined := strings.ReplaceAll(strings.Join(WindowsPackagePatterns, "\n"), "\\", "/")

	must := []struct{ pattern, why string }{
		{"Packages/yt-dlp.yt-dlp_*", "portable package: exe in the package dir"},
		{"Packages/yt-dlp.FFmpeg_*", "zip+nested portable: one package-dir layer first"},
		{"Packages/yt-dlp.FFmpeg_*/*/bin", "one more extract layer; ffmpeg/ffprobe under bin"},
		{"Packages/DenoLand.Deno_*", "yt-dlp's manifest lists Deno as a dependency (JS runtime)"},
	}
	for _, m := range must {
		if !strings.Contains(joined, m.pattern) {
			t.Errorf("missing wildcard pattern %q (%s)", m.pattern, m.why)
		}
	}
}

// ffprobe must be findable too: yt-dlp looks for both ffmpeg and ffprobe in the managed dir
func TestWindowsPatternsIncludeFfprobeBin(t *testing.T) {
	joined := strings.Join(WindowsPackagePatterns, "\n")
	if !strings.Contains(joined, "bin") {
		t.Error("no pattern points at a bin dir; ffprobe would not be found")
	}
}

// **Genuinely verify the expansion logic** with a fake WinGet\Packages tree.
//
// This is stronger than asserting pattern strings: it catches "pattern right but never used".
// It can run on macOS because the patterns are joined with filepath.Join, following the host separator.
func TestExpandWindowsGlobsMatchesRealWingetLayout(t *testing.T) {
	base := t.TempDir()

	// fake the real post-install layout of winget
	mk := func(parts ...string) {
		dir := filepath.Join(append([]string{base}, parts...)...)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		// drop a placeholder file to simulate the binary
		if err := os.WriteFile(filepath.Join(dir, "ffmpeg"), []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	mk("Packages", "yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe")
	mk("Packages", "yt-dlp.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
		"ffmpeg-N-126374-g089a48eb36-win64-gpl", "bin")
	mk("Packages", "DenoLand.Deno_Microsoft.Winget.Source_8wekyb3d8bbwe")

	got := expandWindowsGlobs(base, WindowsPackagePatterns)
	joined := strings.ReplaceAll(strings.Join(got, "\n"), "\\", "/")

	// must expand the bin-containing layer (ffmpeg / ffprobe live there)
	if !strings.Contains(joined, "win64-gpl/bin") {
		t.Errorf("did not expand the nested bin dir; ffmpeg/ffprobe would not be found. Got:\n%s", joined)
	}
	// must also expand the package root (yt-dlp.exe sits directly in the package dir)
	if !strings.Contains(joined, "yt-dlp.yt-dlp_Microsoft") {
		t.Errorf("did not expand yt-dlp's package dir. Got:\n%s", joined)
	}
	if len(got) == 0 {
		t.Fatal("no directories were expanded at all")
	}
}

// Verify through the **real entry point** windowsInstallDirs, not expandWindowsGlobs directly.
//
// This catches "patterns right but the call forgotten" — when calling the expander directly, removing
// the call site still passed (verified: 0 cases failed after injecting that mutation).
func TestWindowsInstallDirsExpandsFakeWingetTree(t *testing.T) {
	home := t.TempDir()
	t.Setenv("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))

	bin := filepath.Join(home, "AppData", "Local", "Microsoft", "WinGet",
		"Packages", "yt-dlp.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
		"ffmpeg-N-126374-g089a48eb36-win64-gpl", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}

	dirs := windowsInstallDirs(home)
	joined := strings.ReplaceAll(strings.Join(dirs, "\n"), "\\", "/")

	if !strings.Contains(joined, "win64-gpl/bin") {
		t.Errorf("windowsInstallDirs did not expand WinGet\\Packages in (forgot the expansion call?). Got:\n%s", joined)
	}
}

func TestWindowsInstallDirsHonorEnvironment(t *testing.T) {
	root := t.TempDir()
	local := filepath.Join(root, "relocated-local")
	programFiles := filepath.Join(root, "programs")
	scoop := filepath.Join(root, "scoop-custom")
	scoopGlobal := filepath.Join(root, "scoop-global")
	chocolatey := filepath.Join(root, "choco-custom")
	t.Setenv("LOCALAPPDATA", local)
	t.Setenv("ProgramFiles", programFiles)
	t.Setenv("SCOOP", scoop)
	t.Setenv("SCOOP_GLOBAL", scoopGlobal)
	t.Setenv("ChocolateyInstall", chocolatey)
	winget := filepath.Join(local, "Microsoft", "WinGet", "Packages", "yt-dlp.yt-dlp_test")
	if err := os.MkdirAll(winget, 0o755); err != nil {
		t.Fatal(err)
	}
	dirs := windowsInstallDirs(filepath.Join(root, "home"))
	for _, want := range []string{winget, filepath.Join(programFiles, "WinGet", "Links"), filepath.Join(scoop, "shims"), filepath.Join(scoopGlobal, "shims"), filepath.Join(chocolatey, "bin")} {
		found := false
		for _, dir := range dirs {
			found = found || dir == want
		}
		if !found {
			t.Errorf("did not use the actual install dir %s", want)
		}
	}
}

// winget's machine-level landing (--scope machine) and user-level are two path sets — cover both.
//
// Covering only user-level would report "installed as admin" users as missing.
func TestWindowsInstallDirsCoverMachineScope(t *testing.T) {
	home := `C:\Users\tester`
	dirs := windowsInstallDirs(home)
	joined := strings.ReplaceAll(strings.Join(dirs, "\n"), "\\", "/")

	if !strings.Contains(joined, "Program Files/WinGet/Links") {
		t.Error("missing machine-level winget Links (winget install --scope machine)")
	}
	// user-level must still be there
	if !strings.Contains(joined, "AppData/Local/Microsoft/WinGet/Links") {
		t.Error("missing user-level winget Links")
	}
}

// The scan must have a wall-clock cap: the dir budget can't bound "every single dir is slow"
// (on Windows, antivirus scanning stacked on top can make one ReadDir take hundreds of ms).
// Without a cap, the "fallback scan" becomes the "dependency detection timed out" users see.
func TestScanRespectsDeadline(t *testing.T) {
	root := t.TempDir()
	deep := filepath.Join(root, "a", "b", "c")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(deep, BinaryName(KindFFmpeg)), []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}

	resetScanBudget()
	scanDeadline = time.Now().Add(-1 * time.Second) // already expired
	if got := scanDir(root, BinaryName(KindFFmpeg), 0); got != "" {
		t.Errorf("kept scanning past the deadline: %s", got)
	}
}

// findOne must reset the deadline, or after the first dep times out the rest can't scan.
//
// Assert "the deadline was replaced with a later value", not "the deadline is after now":
// the latter depends on **actual scan time** — on Windows a missing ffprobe really scans the full 3s budget,
// so the deadline lands in the past and the assertion fails; on macOS a candidate-dir hit skips scanning and it passes.
// The same code concluding differently per platform means the assertion targeted the wrong thing (CI caught exactly this).
func TestFindOneResetsScanDeadline(t *testing.T) {
	stale := time.Now().Add(-1 * time.Second)
	scanDeadline = stale

	_ = FindOne(KindFFprobe, Options{ManagedDir: t.TempDir()})

	if !scanDeadline.After(stale) {
		t.Errorf("FindOne did not reset the scan deadline: still %v", scanDeadline)
	}
}

// yt-dlp's version threshold must match the manifest-pinned tag, not just the year.
//
// Regression background: MinimumMajor["yt-dlp"] = 2024 used to judge by year only,
// while the 2026.08.19 build was observed failing YouTube with `Requested format is not available`
// (upstream fixed the same class of issue in a newer build) yet "passed detection" — leaving users stuck on a build that can't run.
func TestYtDlpVersionGateUsesPinnedTag(t *testing.T) {
	const pinned = "2026.10.10.233141"
	MinVersions[KindYtDlp] = pinned
	defer delete(MinVersions, KindYtDlp)

	older := probe.Info{Version: "2026.08.19", Major: 2026}
	if isAcceptableVersion(KindYtDlp, older) {
		t.Error("2026.08.19 is older than the pinned version and should be unusable (exactly the version users reported)")
	}
	// the message should carry "current version" and "required version" for the user to judge
	reason := staleReason(KindYtDlp, older).Error()
	if !strings.Contains(reason, "2026.08.19") || !strings.Contains(reason, pinned) {
		t.Errorf("the too-old message should include both current and required versions, got: %s", reason)
	}

	same := probe.Info{Version: pinned, Major: 2026}
	if !isAcceptableVersion(KindYtDlp, same) {
		t.Error("the pinned version itself should be usable")
	}
	newer := probe.Info{Version: "2026.11.01", Major: 2026}
	if !isAcceptableVersion(KindYtDlp, newer) {
		t.Error("a newer-than-pinned version should be usable")
	}
}

// without an injected threshold, fall back to the coarse check — don't condemn every version
func TestVersionGateFallsBackWhenNotInjected(t *testing.T) {
	delete(MinVersions, KindYtDlp)
	if !isAcceptableVersion(KindYtDlp, probe.Info{Version: "2026.08.19", Major: 2026}) {
		t.Error("should fall back to major-version judgment when no threshold is injected")
	}
}

// ffmpeg etc. still judge by major version and must not be affected by yt-dlp's date threshold
func TestFfmpegGateUnaffected(t *testing.T) {
	MinVersions[KindYtDlp] = "2026.10.10.233141"
	defer delete(MinVersions, KindYtDlp)
	if !isAcceptableVersion(KindFFmpeg, probe.Info{Version: "6.0", Major: 6}) {
		t.Error("ffmpeg 6.0 should be usable")
	}
	if isAcceptableVersion(KindFFmpeg, probe.Info{Version: "2.8", Major: 2}) {
		t.Error("ffmpeg 2.8 is too old and should be unusable")
	}
}
