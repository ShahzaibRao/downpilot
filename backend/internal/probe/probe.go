// Package probe executes yt-dlp / ffmpeg / ffprobe / gallery-dl / deno and parses their versions.
package probe

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// CandidateTimeout is the time limit for executing the **managed copy** (the one DownPilot downloaded itself).
//
// Why 15 seconds and not the former 3: yt-dlp's official macOS build is PyInstaller-packed
// (~37MB), and `--version` stably takes 8-10s on this machine, while the **first run right
// after download** is even slower (three measured first runs: 9.7s / 8.9s / 12.4s — ad-hoc signature
// checks and page cache not yet warm). With a 3s budget, detection always timed out with "execution
// timed out, file may be corrupt", so **a just-downloaded managed copy was judged unusable**: the user
// watched the progress bar finish, but the UI still said "download" — clicking again never helped.
const CandidateTimeout = 15 * time.Second

// SystemCandidateTimeout is the time limit for executing the **system copy** (PATH / common install dirs).
//
// Deliberately much shorter than the managed copy's, for two reasons:
//   - system copies are usually Python zipapps (Homebrew / uv / pipx); `--version` takes
//     0.2s — anything not answering within 5s is basically a broken file or a stuck process
//   - **each stuck candidate eats a whole timeout**. The candidate list can hold a dozen paths
//     (PATH + common install dirs per platform); 15s each would drag one detection out
//     for minutes. The Windows regression case (two stuck candidates before the healthy copy)
//     is exactly what exposed this
const SystemCandidateTimeout = 5 * time.Second

// Args are the version-probe arguments per tool
var Args = map[string][]string{
	"yt-dlp":     {"--version"},
	"ffmpeg":     {"-version"},
	"ffprobe":    {"-version"},
	"gallery-dl": {"--version"},
	"deno":       {"--version"},
}

// MinimumMajor is the minimum major version for a tool to count as usable.
// yt-dlp uses date versions (2026.10.10), so the major version is the year:
// versions before 2024 are broken on many sites — re-download is recommended.
var MinimumMajor = map[string]int{
	"yt-dlp":     2024,
	"ffmpeg":     4,
	"ffprobe":    4,
	"gallery-dl": 1,
	"deno":       1,
}

// Info is one successful version-probe result
type Info struct {
	Path    string
	Version string
	Major   int
}

var (
	reFFmpegVersion = regexp.MustCompile(`version\s+(\S+)`)
	reYtDlpVersion  = regexp.MustCompile(`^\d{4}\.\d{2}\.\d{2}(?:\.\d+)?$`)
	// gallery-dl nightly versions look like "1.33.0-dev:2026.10.17": the meaningful part is the date after the colon
	// (same format as the manifest-pinned GalleryDlTag); stable builds just print "1.32.16"
	reGalleryDlDate    = regexp.MustCompile(`(\d{4}\.\d{2}\.\d{2})\s*$`)
	reGalleryDlVersion = regexp.MustCompile(`^(\d+\.\d+\.\d+)`)
	reDenoVersion   = regexp.MustCompile(`^deno\s+(\S+)`)
	reDigits        = regexp.MustCompile(`\d+`)
	reKilled        = regexp.MustCompile(`(?i)killed|signal: 9`)
)

// Run executes a tool and parses its version; the returned error text is safe to show users directly
func Run(tool, path string) (Info, error) {
	return RunContext(context.Background(), tool, path)
}

// RunContext is bound by both the caller's total budget and the per-candidate timeout.
func RunContext(ctx context.Context, tool, path string) (Info, error) {
	return RunWithTimeout(ctx, tool, path, CandidateTimeout)
}

// RunWithTimeout is like RunContext, but the caller sets the per-candidate timeout.
//
// It's needed because **candidates from different sources deserve different budgets**: the managed copy is
// our own download of the official PyInstaller build (8-12s), while system copies are usually 0.2s zipapps.
// Giving everyone the long budget lets stuck system copies drag detection down (see SystemCandidateTimeout).
func RunWithTimeout(ctx context.Context, tool, path string, timeout time.Duration) (Info, error) {
	args, ok := Args[tool]
	if !ok {
		args = []string{"--version"}
	}

	info := Info{Path: path}
	out, err := run(ctx, path, args, timeout)
	if err != nil {
		return info, describeRunError(err, out)
	}
	info.Version = ParseVersion(tool, out)
	info.Major = Major(info.Version)

	if info.Version == "" {
		return info, errors.New("cannot parse version output: " + firstLine(out))
	}
	return info, nil
}

// ParseVersion extracts the version number from command output
func ParseVersion(tool, out string) string {
	line := firstNonEmptyLine(out)
	if line == "" {
		return ""
	}
	// ffmpeg / ffprobe：`ffmpeg version 6.0 Copyright (c) ...`
	if tool == "ffmpeg" || tool == "ffprobe" {
		if m := reFFmpegVersion.FindStringSubmatch(line); strings.HasPrefix(line, tool+" version ") && len(m) == 2 && Major(m[1]) > 0 {
			return m[1]
		}
		return ""
	}
	// yt-dlp: prints the version directly
	if tool == "yt-dlp" && reYtDlpVersion.MatchString(line) {
		return line
	}
	// gallery-dl: nightly's first line looks like "1.33.0-dev:2026.10.17" (take the date), stable is "1.32.16"
	if tool == "gallery-dl" {
		if m := reGalleryDlDate.FindStringSubmatch(line); len(m) == 2 {
			return m[1]
		}
		if m := reGalleryDlVersion.FindStringSubmatch(line); len(m) == 2 {
			return m[1]
		}
		return ""
	}
	// deno: first line looks like "deno 2.9.7 (stable, release, x86_64-...)"
	if tool == "deno" {
		if m := reDenoVersion.FindStringSubmatch(line); len(m) == 2 {
			return m[1]
		}
		return ""
	}
	return ""
}

// CompareVersions compares a and b "numeric-segment by numeric-segment", returning -1 / 0 / 1.
//
// Works for yt-dlp's date versions (2026.10.10.233141) and ffmpeg's semver (6.0).
// No full semver parsing: the only use here is "is it older than the manifest-pinned version".
func CompareVersions(a, b string) int {
	pa := versionParts(a)
	pb := versionParts(b)
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	return 0
}

// IsOlder reports whether version is older than min
func IsOlder(version, min string) bool {
	if version == "" || min == "" {
		return false // unknown version is never judged too old, to avoid false positives
	}
	return CompareVersions(version, min) < 0
}

// versionParts extracts all numeric segments; non-numeric prefixes (like ffmpeg's "n7.1") are skipped
func versionParts(v string) []int {
	var parts []int
	for _, seg := range reDigits.FindAllString(v, -1) {
		n, err := strconv.Atoi(seg)
		if err != nil {
			continue
		}
		parts = append(parts, n)
	}
	return parts
}

// Major takes the first numeric segment of a version (for yt-dlp's date versions, that's the year)
func Major(version string) int {
	m := reDigits.FindString(version)
	if m == "" {
		return 0
	}
	n, err := strconv.Atoi(m)
	if err != nil {
		return 0
	}
	return n
}

func run(parent context.Context, path string, args []string, timeout time.Duration) (string, error) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, path, args...)
	hideWindow(cmd)
	sink := &limitedBuffer{limit: 64 << 10}
	cmd.Stdout = sink
	cmd.Stderr = sink

	// **WaitDelay is mandatory**: after a timeout, exec.CommandContext only kills the **direct child**.
	// Our candidates are shell scripts or PyInstaller launchers, which spawn children of their own,
	// and the grandchild inherits the stdout pipe. The child is killed, the grandchild lives on,
	// the pipe never closes → `cmd.Run()` waits on I/O forever → **detection blows past its budget**.
	//
	// Observed: a fake `sleep 300` binary dragged a 5s-budget probe out to 300s
	// (reproduced for real in unit tests). From the user's side, the UI froze for tens of seconds to minutes,
	// finally reporting "dependency detection timed out" — when the real cause was that grandchild.
	//
	// WaitDelay makes Wait force-close the pipe and return after waiting this long past process exit.
	cmd.WaitDelay = 2 * time.Second

	err := cmd.Run()
	if ctx.Err() != nil {
		err = ctx.Err()
	}
	return sink.String(), err
}

// describeRunError translates low-level execution errors into user-readable messages
func describeRunError(err error, out string) error {
	msg := err.Error()
	switch {
	case strings.Contains(msg, "context deadline exceeded"):
		// Timeout ≠ corrupt: yt-dlp's official macOS build needs 8-10s for a cold start,
		// so wording it too absolutely would mislead both the user's patience and their debugging
		return errors.New("execution timed out (the executable responded too slowly \u2014 it may be corrupt, or just slow on first run)")
	case strings.Contains(msg, "context canceled"):
		// Parent context was canceled (e.g. the overall detection hit its deadline). Without this branch,
		// the raw English "context canceled" would land in the UI — error messages must all be user-readable.
		return errors.New("execution timed out (detection was interrupted)")
	case reKilled.MatchString(msg) || reKilled.MatchString(out):
		return errors.New("cannot execute (the macOS build may be corrupt or unsigned; re-download it)")
	case strings.Contains(msg, "permission denied"):
		return errors.New("no execute permission (chmod +x)")
	case strings.Contains(msg, "no such file or directory"), strings.Contains(msg, "cannot find"):
		return errors.New("file does not exist")
	case strings.Contains(msg, "exec format error"), strings.Contains(msg, "bad CPU type"),
		strings.Contains(msg, "not a valid Win32 application"), strings.Contains(msg, "%1 is not a valid"):
		return errors.New("bad file format (the download may be incomplete or built for another CPU architecture); re-download it")
	}
	if line := firstLine(out); line != "" {
		return errors.New(line)
	}
	return err
}

func firstNonEmptyLine(s string) string {
	for _, line := range strings.Split(s, "\n") {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return strings.TrimSpace(s)
}

// limitedBuffer keeps only the first limit bytes, so ffmpeg's verbose output can't blow up memory
type limitedBuffer struct {
	limit int
	buf   bytes.Buffer
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if remaining := b.limit - b.buf.Len(); remaining > 0 {
		if len(p) > remaining {
			b.buf.Write(p[:remaining])
		} else {
			b.buf.Write(p)
		}
	}
	return len(p), nil
}

func (b *limitedBuffer) String() string { return b.buf.String() }
