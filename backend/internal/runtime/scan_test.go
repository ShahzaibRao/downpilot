package runtime

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// Fallback scan: when no known dir hits, find it in common "places where users put things".
//
// Verify with a real directory layout in a temp dir, not by asserting candidate-list strings.
func TestScanFindsBinaryInNestedDir(t *testing.T) {
	root := t.TempDir()
	// fake `~/Downloads/ffmpeg-8.1/bin/ffmpeg`
	bin := filepath.Join(root, "Downloads", "ffmpeg-8.1", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(bin, BinaryName(KindFFmpeg))
	if err := os.WriteFile(target, []byte("#!/bin/sh\necho 'ffmpeg version 8.1'\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	resetScanBudget()
	got := scanDir(filepath.Join(root, "Downloads"), BinaryName(KindFFmpeg), 0)
	if got == "" {
		t.Fatal("ffmpeg not found in nested dirs (fallback scan broken)")
	}
	if filepath.Base(got) != BinaryName(KindFFmpeg) {
		t.Errorf("wrong file name found: %s", got)
	}
}

func TestScanContinuesAfterRejectedCopy(t *testing.T) {
	root := t.TempDir()
	name := BinaryName(KindFFprobe)
	var valid string
	for _, sub := range []string{"a-broken", "b-valid"} {
		dir := filepath.Join(root, sub)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		file := filepath.Join(dir, name)
		if err := os.WriteFile(file, []byte("fixture"), 0o755); err != nil {
			t.Fatal(err)
		}
		valid = file
	}
	resetScanBudget()
	got := scanDirMatching(root, name, 0, func(file string) bool { return file == valid })
	if got != valid {
		t.Fatalf("did not keep scanning after rejecting the first copy: %q, expected %q", got, valid)
	}
}

// depth limit must hold: overly deep dirs must not be walked
func TestScanRespectsMaxDepth(t *testing.T) {
	root := t.TempDir()
	deep := root
	for i := 0; i < scanMaxDepth+3; i++ {
		deep = filepath.Join(deep, "d")
	}
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(deep, BinaryName(KindYtDlp)), []byte("#!/bin/sh\necho 2026.01.01\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	resetScanBudget()
	if got := scanDir(root, BinaryName(KindYtDlp), 0); got != "" {
		t.Errorf("found past the depth limit: %s (depth limit broken — slow on Windows)", got)
	}
}

// must stop when the budget is spent — no unbounded walking
func TestScanRespectsBudget(t *testing.T) {
	root := t.TempDir()
	// build a dir chain deeper than the budget
	deep := root
	for i := 0; i < 20; i++ {
		deep = filepath.Join(deep, "d")
	}
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	// put the target at level 10 (past a 3-dir budget, but within the depth limit)
	targetDir := root
	for i := 0; i < 3; i++ {
		targetDir = filepath.Join(targetDir, "d")
	}
	if err := os.WriteFile(filepath.Join(targetDir, BinaryName(KindYtDlp)), []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}

	setScanBudgetForTest(2) // budget too small to reach level 3
	if got := scanDir(root, BinaryName(KindYtDlp), 0); got != "" {
		t.Errorf("file found after budget exhaustion: %s", got)
	}
}

// Key: the budget counts **dirs**, not entries.
//
// Regression background: it used to count entries (20000), and scanning C:\Program Files on Windows
// let one big dir eat the whole budget, making the fallback scan useless. CI's windows job exposed it.
func TestBudgetCountsDirsNotEntries(t *testing.T) {
	root := t.TempDir()
	// stuff one dir with many files (simulating big dirs like Program Files)
	for i := 0; i < 5000; i++ {
		if err := os.WriteFile(filepath.Join(root, fmt.Sprintf("f%d.txt", i)), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// target is one level down
	sub := filepath.Join(root, "bin")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, BinaryName(KindFFmpeg)), []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}

	// budget allows entering 10 dirs, but the 5000 files in the big dir must not consume it
	setScanBudgetForTest(10)
	if got := scanDir(root, BinaryName(KindFFmpeg), 0); got == "" {
		t.Error("file count in a big dir must not consume the budget (or Windows scans fail)")
	}
}

// irrelevant dirs must be skipped (or we'd wastefully scan huge dirs like node_modules)
func TestShouldSkipDir(t *testing.T) {
	skip := []string{"node_modules", ".git", "Cache", "Windows", "System32", "AppData", "tmp"}
	for _, d := range skip {
		if !shouldSkipDir(d) {
			t.Errorf("%q should be skipped", d)
		}
	}
	keep := []string{"Downloads", "ffmpeg-8.1", "bin", "yt-dlp"}
	for _, d := range keep {
		if shouldSkipDir(d) {
			t.Errorf("%q should not be skipped", d)
		}
	}
}

// each dependency gets its own budget, so one can't drain the next into a miss.
//
// Assert "the reset value equals the cap", not "remaining > 1": the latter depends on whether
// a scan actually happened (macOS returns early on a candidate-dir hit, Windows doesn't), making
// the same code behave differently per platform — exactly the first version's bug.
func TestFindOneResetsScanBudget(t *testing.T) {
	scanDirsLeft = 1
	_ = FindOne(KindFFprobe, Options{ManagedDir: t.TempDir()})
	if scanDirsLeft == 1 {
		t.Errorf("FindOne did not reset the scan budget, %d left", scanDirsLeft)
	}
}
