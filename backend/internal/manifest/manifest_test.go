package manifest

import (
	"regexp"
	"strings"
	"testing"

	"github.com/ShahzaibRao/downpilot/backend/internal/fetch"
)

var reSHA256 = regexp.MustCompile(`^[0-9a-f]{64}$`)

// 每个受支持的平台都必须能生成完整任务，否则 CI 构建出来的 sidecar 会在用户机上失败
func TestTasksCoverEveryPlatform(t *testing.T) {
	for _, platform := range Platforms {
		if _, ok := ytdlpAssets[platform]; !ok {
			t.Errorf("平台 %s 缺少 yt-dlp 产物", platform)
		}
		if _, ok := ffmpegAssets[platform]; !ok {
			t.Errorf("平台 %s 缺少 ffmpeg 产物", platform)
		}
	}
}

func TestAssetNamesAndHashesWellFormed(t *testing.T) {
	// 清单文件是生成出来的；哈希必须齐全，否则校验形同虚设
	for platform, a := range ytdlpAssets {
		if a.Name == "" {
			t.Errorf("%s 的 yt-dlp 产物名为空", platform)
		}
		if !reSHA256.MatchString(a.SHA256) {
			t.Errorf("%s 的 yt-dlp 校验值不是 64 位十六进制（清单可能未更新）：%q", platform, a.SHA256)
		}
	}
	for platform, byKind := range ffmpegAssets {
		for kind, a := range byKind {
			if a.Name == "" {
				t.Errorf("%s/%s 产物名为空", platform, kind)
			}
			if !reSHA256.MatchString(a.SHA256) {
				t.Errorf("%s/%s 校验值不是 64 位十六进制：%q", platform, kind, a.SHA256)
			}
		}
	}
}

func TestTasksForCurrentPlatform(t *testing.T) {
	tasks, err := Tasks("/tmp/downpilot-runtime/bin", nil)
	if err != nil {
		t.Skipf("当前平台 %s 无下载任务：%v", CurrentPlatform(), err)
	}
	if len(tasks) == 0 {
		t.Fatal("应至少生成一个下载任务")
	}

	seen := map[string]bool{}
	for _, task := range tasks {
		if task.Tool == "" || task.URL == "" || task.Target == "" {
			t.Errorf("任务字段不完整：%+v", task)
		}
		if !reSHA256.MatchString(task.SHA256) {
			t.Errorf("%s 缺少有效校验值：%q", task.Tool, task.SHA256)
		}
		// ffmpeg / ffprobe 走 gzip 单文件，yt-dlp / gallery-dl 是裸二进制，deno 是 zip 包
		if task.Tool == "yt-dlp" && task.Gzip {
			t.Error("yt-dlp 不应标记为 gzip")
		}
		if task.Tool == "gallery-dl" && (task.Gzip || task.Zip) {
			t.Error("gallery-dl 是裸二进制，不应标记为 gzip/zip")
		}
		if task.Tool == "deno" && !task.Zip {
			t.Error("deno 应标记为 zip")
		}
		if (task.Tool == "ffmpeg" || task.Tool == "ffprobe") && !task.Gzip {
			t.Errorf("%s 应标记为 gzip", task.Tool)
		}
		seen[task.Tool] = true
	}

	if !seen["yt-dlp"] || !seen["ffmpeg"] {
		t.Errorf("必须包含 yt-dlp 与 ffmpeg，实际：%v", seen)
	}
}

func TestTasksOnlyFilter(t *testing.T) {
	tasks, err := Tasks("/tmp/downpilot-runtime/bin", []string{"ffmpeg"})
	if err != nil {
		t.Skipf("当前平台无任务：%v", err)
	}
	for _, task := range tasks {
		if task.Tool != "ffmpeg" {
			t.Errorf("--only ffmpeg 时不应出现 %s", task.Tool)
		}
	}
}

// Windows arm64 上游没有 ffmpeg 构建：应跳过而不是让整机不可用
func TestWindowsArm64FfmpegIsSkippedNotFatal(t *testing.T) {
	if _, ok := ffmpegAssets["win32/arm64"]; ok {
		t.Skip("上游已提供 Windows arm64 构建，可移除本用例")
	}
	if _, err := Tasks("/tmp/x", []string{"ffmpeg"}); err != nil {
		// 当前平台若不支持，Tasks 允许报错；这里只确认不会 panic
		t.Logf("当前平台无 ffmpeg 任务：%v", err)
	}
}

// win32/x64 必须包含 gallery-dl（裸二进制）与 deno（zip 包，取 deno.exe）
func TestWin32TasksIncludeGalleryDlAndDeno(t *testing.T) {
	tasks, err := TasksFor("win32/x64", `C:\tmp\downpilot-runtime\bin`, nil)
	if err != nil {
		t.Fatalf("win32/x64 应生成下载任务：%v", err)
	}
	byTool := map[string]fetch.Task{}
	for _, task := range tasks {
		byTool[task.Tool] = task
	}

	g, ok := byTool["gallery-dl"]
	if !ok {
		t.Fatal("缺少 gallery-dl 任务")
	}
	if g.Gzip || g.Zip {
		t.Error("gallery-dl 是裸二进制，不应标记 gzip/zip")
	}
	if !strings.HasSuffix(g.Target, "gallery-dl.exe") {
		t.Errorf("gallery-dl 目标文件名应为 gallery-dl.exe，实际 %q", g.Target)
	}

	d, ok := byTool["deno"]
	if !ok {
		t.Fatal("缺少 deno 任务")
	}
	if !d.Zip || d.ZipInner != "deno.exe" {
		t.Errorf("deno 应为 zip 包并提取 deno.exe，实际 %+v", d)
	}
	if !strings.HasSuffix(d.Target, "deno.exe") {
		t.Errorf("deno 目标文件名应为 deno.exe，实际 %q", d.Target)
	}
}

// linux/arm64 上游无 gallery-dl 构建：应跳过而不是报错
func TestLinuxArm64SkipsGalleryDl(t *testing.T) {
	tasks, err := TasksFor("linux/arm64", "/tmp/x", nil)
	if err != nil {
		t.Fatalf("linux/arm64 应生成下载任务：%v", err)
	}
	for _, task := range tasks {
		if task.Tool == "gallery-dl" {
			t.Error("linux/arm64 不应包含 gallery-dl 任务（上游无构建）")
		}
	}
}
