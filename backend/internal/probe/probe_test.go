package probe

import "testing"

func TestParseVersion(t *testing.T) {
	cases := []struct {
		tool string
		out  string
		want string
	}{
		{"yt-dlp", "2026.10.10.233141\n", "2026.10.10.233141"},
		{"yt-dlp", "\n\n  2025.01.15  \n", "2025.01.15"},
		{"ffmpeg", "ffmpeg version 6.0 Copyright (c) 2000-2023 the FFmpeg developers", "6.0"},
		{"ffmpeg", "ffmpeg version 9.0.2 Copyright (c) 2000-2025", "9.0.2"},
		{"ffprobe", "ffprobe version n7.1-static Copyright (c)", "n7.1-static"},
		{"yt-dlp", "", ""},
		{"yt-dlp", "ERROR: missing runtime DLL", ""},
		{"yt-dlp", "2026.10.10 error", ""},
		{"ffmpeg", "ERROR: missing runtime DLL", ""},
		{"ffmpeg", "ffmpeg version unknown", ""},
		{"ffmpeg", "another tool version 6.0", ""},
		{"gallery-dl", "1.32.16\n", "1.32.16"},
		{"gallery-dl", "1.32.9\n", "1.32.9"},
		{"gallery-dl", "1.33.0-dev:2026.10.17\n", "2026.10.17"},
		{"gallery-dl", "ERROR: missing runtime DLL", ""},
		{"deno", "deno 2.9.7 (stable, release, x86_64-pc-windows-msvc)\nv8 14.4.299.1\ntypescript 5.9.2\n", "2.9.7"},
		{"deno", "deno 1.46.3 (stable, release, aarch64-apple-darwin)\n", "1.46.3"},
		{"deno", "ERROR: missing runtime DLL", ""},
	}
	for _, c := range cases {
		if got := ParseVersion(c.tool, c.out); got != c.want {
			t.Errorf("ParseVersion(%q, %q) = %q, 期望 %q", c.tool, c.out, got, c.want)
		}
	}
}

func TestMajor(t *testing.T) {
	cases := map[string]int{
		"2026.10.10.233141": 2026, // yt-dlp 日期版本 -> 年份
		"6.0":               6,
		"n7.1-static":       7,
		"":                  0,
		"unknown":           0,
	}
	for in, want := range cases {
		if got := Major(in); got != want {
			t.Errorf("Major(%q) = %d, 期望 %d", in, got, want)
		}
	}
}

func TestMinimumMajorRejectsStaleYtDlp(t *testing.T) {
	// 2022 年的 yt-dlp 大量站点已失效，应判为不可用
	if got := Major("2022.11.11"); got >= MinimumMajor["yt-dlp"] {
		t.Errorf("2022.11.11 应低于最低要求 %d，实际判定 %d", MinimumMajor["yt-dlp"], got)
	}
	if got := Major("2026.10.10"); got < MinimumMajor["yt-dlp"] {
		t.Errorf("2026.10.10 应满足最低要求 %d，实际判定 %d", MinimumMajor["yt-dlp"], got)
	}
}
