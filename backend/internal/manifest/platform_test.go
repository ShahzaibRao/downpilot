package manifest

import (
	"runtime"
	"testing"
)

// Platform keys must match electron-builder's ${platform}-${arch} naming.
//
// Regression background: this used to use Go's GOOS/GOARCH directly, producing "windows/amd64" on Windows,
// while the asset table is keyed "win32/x64" — lookups always failed, and users saw
// "yt-dlp downloads are not supported on windows/amd64".
// macOS/Linux happen to use identical naming, so neither local runs nor the CI mac/linux jobs caught it.
//
// So cases must **explicitly feed Windows values**, not `if runtime.GOOS == "windows"`
// — the latter tests nothing on macOS (the first version was written that way and still passed after mutation).

func TestPlatformKeyMapsWindowsNaming(t *testing.T) {
	cases := []struct {
		goos, goarch string
		want         string
		why          string
	}{
		{"windows", "amd64", "win32/x64", "Go's windows/amd64 != electron's win32/x64 (the incident)"},
		{"windows", "arm64", "win32/arm64", "Windows arm64"},
		{"darwin", "arm64", "darwin/arm64", "both namings agree, must not be renamed"},
		{"darwin", "amd64", "darwin/x64", "amd64 → x64"},
		{"linux", "amd64", "linux/x64", "amd64 → x64"},
		{"linux", "arm64", "linux/arm64", "arm64 stays"},
	}
	for _, c := range cases {
		if got := PlatformKey(c.goos, c.goarch); got != c.want {
			t.Errorf("PlatformKey(%q, %q) = %q, expected %q (%s)", c.goos, c.goarch, got, c.want, c.why)
		}
	}
}

// Go's naming must never be used as asset-table keys
func TestGoNamingIsNotUsedAsKey(t *testing.T) {
	if _, ok := ytdlpAssets["windows/amd64"]; ok {
		t.Error("asset table contains Go naming windows/amd64; unify to win32/x64")
	}
	if _, ok := ytdlpAssets["win32/x64"]; !ok {
		t.Error("asset table is missing win32/x64 — Windows users could not download dependencies")
	}
	if got := PlatformKey("windows", "amd64"); got != "win32/x64" {
		t.Errorf("Windows must produce win32/x64, got %q", got)
	}
}

// the current host platform must also resolve the table (otherwise Tasks errors outright)
func TestCurrentPlatformResolvable(t *testing.T) {
	got := CurrentPlatform()
	if _, ok := ytdlpAssets[got]; !ok {
		t.Errorf("platform key %q not found in ytdlpAssets", got)
	}
	if _, ok := ffmpegAssets[got]; !ok {
		t.Errorf("platform key %q not found in ffmpegAssets", got)
	}
	if _, err := Tasks("/tmp/x", nil); err != nil {
		t.Fatalf("current platform (%s, Go side %s/%s) should generate download tasks: %v", got, runtime.GOOS, runtime.GOARCH, err)
	}
}

// issue #40's minimal repro is running on Windows:
//
//	dp-deps.exe fetch --managed-dir <dir> --only ffmpeg --timeout 20
//	→ {"event":"error","message":"ffmpeg downloads are not supported on windows/amd64"}
//
// Windows binaries can't run on this machine, so feed win32/x64 explicitly via TasksFor,
// verifying this path also works on macOS.
func TestWindowsFetchPathProducesTasks(t *testing.T) {
	for _, platform := range []string{"win32/x64", "darwin/x64", "linux/x64", "darwin/arm64", "linux/arm64"} {
		for _, only := range [][]string{nil, {"yt-dlp"}, {"ffmpeg"}, {"ffprobe"}} {
			tasks, err := TasksFor(platform, `C:\tmp\downpilot-runtime`, only)
			if err != nil {
				t.Errorf("platform %s only=%v should generate tasks, but errored: %v", platform, only, err)
				continue
			}
			if len(tasks) == 0 {
				t.Errorf("platform %s only=%v generated no tasks", platform, only)
			}
		}
	}
}

// the incident fed Go naming, which must still error (not silently generate wrong tasks)
func TestGoNamingStillFailsLoudly(t *testing.T) {
	if _, err := TasksFor("windows/amd64", "/tmp/x", nil); err == nil {
		t.Error("Go naming input should error, to avoid silently generating wrong tasks")
	}
}
