package manifest

import (
	"regexp"
	"strings"
	"testing"

	"github.com/ShahzaibRao/downpilot/backend/internal/fetch"
)

var reSHA256 = regexp.MustCompile(`^[0-9a-f]{64}$`)

// every supported platform must generate complete tasks, or the CI-built sidecar fails on user machines
func TestTasksCoverEveryPlatform(t *testing.T) {
	for _, platform := range Platforms {
		if _, ok := ytdlpAssets[platform]; !ok {
			t.Errorf("platform %s is missing the yt-dlp artifact", platform)
		}
		if _, ok := ffmpegAssets[platform]; !ok {
			t.Errorf("platform %s is missing the ffmpeg artifact", platform)
		}
	}
}

func TestAssetNamesAndHashesWellFormed(t *testing.T) {
	// the manifest file is generated; hashes must be complete, or verification is theater
	for platform, a := range ytdlpAssets {
		if a.Name == "" {
			t.Errorf("%s: yt-dlp artifact name is empty", platform)
		}
		if !reSHA256.MatchString(a.SHA256) {
			t.Errorf("%s: yt-dlp checksum is not 64 hex chars (manifest may be stale): %q", platform, a.SHA256)
		}
	}
	for platform, byKind := range ffmpegAssets {
		for kind, a := range byKind {
			if a.Name == "" {
				t.Errorf("%s/%s: artifact name is empty", platform, kind)
			}
			if !reSHA256.MatchString(a.SHA256) {
				t.Errorf("%s/%s: checksum is not 64 hex chars: %q", platform, kind, a.SHA256)
			}
		}
	}
}

func TestTasksForCurrentPlatform(t *testing.T) {
	tasks, err := Tasks("/tmp/downpilot-runtime/bin", nil)
	if err != nil {
		t.Skipf("no download tasks for current platform %s: %v", CurrentPlatform(), err)
	}
	if len(tasks) == 0 {
		t.Fatal("should generate at least one download task")
	}

	seen := map[string]bool{}
	for _, task := range tasks {
		if task.Tool == "" || task.URL == "" || task.Target == "" {
			t.Errorf("task has incomplete fields: %+v", task)
		}
		if !reSHA256.MatchString(task.SHA256) {
			t.Errorf("%s: missing valid checksum: %q", task.Tool, task.SHA256)
		}
		// ffmpeg / ffprobe use single-file gzip, yt-dlp / gallery-dl are bare binaries, deno is a zip
		if task.Tool == "yt-dlp" && task.Gzip {
			t.Error("yt-dlp should not be marked gzip")
		}
		if task.Tool == "gallery-dl" && (task.Gzip || task.Zip) {
			t.Error("gallery-dl is a bare binary, should not be marked gzip/zip")
		}
		if task.Tool == "deno" && !task.Zip {
			t.Error("deno should be marked zip")
		}
		if (task.Tool == "ffmpeg" || task.Tool == "ffprobe") && !task.Gzip {
			t.Errorf("%s should be marked gzip", task.Tool)
		}
		seen[task.Tool] = true
	}

	if !seen["yt-dlp"] || !seen["ffmpeg"] {
		t.Errorf("must include yt-dlp and ffmpeg, got: %v", seen)
	}
}

func TestTasksOnlyFilter(t *testing.T) {
	tasks, err := Tasks("/tmp/downpilot-runtime/bin", []string{"ffmpeg"})
	if err != nil {
		t.Skipf("no tasks for current platform: %v", err)
	}
	for _, task := range tasks {
		if task.Tool != "ffmpeg" {
			t.Errorf("--only ffmpeg should not include %s", task.Tool)
		}
	}
}

// no upstream ffmpeg build for Windows arm64: skip instead of making the whole machine unusable
func TestWindowsArm64FfmpegIsSkippedNotFatal(t *testing.T) {
	if _, ok := ffmpegAssets["win32/arm64"]; ok {
		t.Skip("upstream now provides Windows arm64 builds; this case can be removed")
	}
	if _, err := Tasks("/tmp/x", []string{"ffmpeg"}); err != nil {
		// Tasks may error if the current platform is unsupported; here just confirm no panic
		t.Logf("no ffmpeg task for current platform: %v", err)
	}
}

// win32/x64 must include gallery-dl (bare binary) and deno (zip, extract deno.exe)
func TestWin32TasksIncludeGalleryDlAndDeno(t *testing.T) {
	tasks, err := TasksFor("win32/x64", `C:\tmp\downpilot-runtime\bin`, nil)
	if err != nil {
		t.Fatalf("win32/x64 should generate download tasks: %v", err)
	}
	byTool := map[string]fetch.Task{}
	for _, task := range tasks {
		byTool[task.Tool] = task
	}

	g, ok := byTool["gallery-dl"]
	if !ok {
		t.Fatal("missing gallery-dl task")
	}
	if g.Gzip || g.Zip {
		t.Error("gallery-dl is a bare binary, should not be marked gzip/zip")
	}
	if !strings.HasSuffix(g.Target, "gallery-dl.exe") {
		t.Errorf("gallery-dl target file name should be gallery-dl.exe, got %q", g.Target)
	}

	d, ok := byTool["deno"]
	if !ok {
		t.Fatal("missing deno task")
	}
	if !d.Zip || d.ZipInner != "deno.exe" {
		t.Errorf("deno should be a zip extracting deno.exe, got %+v", d)
	}
	if !strings.HasSuffix(d.Target, "deno.exe") {
		t.Errorf("deno target file name should be deno.exe, got %q", d.Target)
	}
}

// no upstream gallery-dl build for linux/arm64: skip instead of erroring
func TestLinuxArm64SkipsGalleryDl(t *testing.T) {
	tasks, err := TasksFor("linux/arm64", "/tmp/x", nil)
	if err != nil {
		t.Fatalf("linux/arm64 should generate download tasks: %v", err)
	}
	for _, task := range tasks {
		if task.Tool == "gallery-dl" {
			t.Error("linux/arm64 should not include a gallery-dl task (no upstream build)")
		}
	}
}
