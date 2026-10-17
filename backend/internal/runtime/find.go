// Package runtime finds yt-dlp / ffmpeg / ffprobe / gallery-dl / deno on the machine.
//
// Search order (managed dir first, then system locations):
//  1. Explicitly specified path (manually chosen in Settings)
//  2. userData managed dir (downloaded and installed by DownPilot itself)
//  3. Login shell's PATH (GUI apps often don't get the full PATH — this step is critical)
//  4. Common install dirs per platform (Homebrew / winget / scoop / distro paths)
package runtime

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/ShahzaibRao/downpilot/backend/internal/probe"
)

// Kind is the dependency kind
type Kind string

const (
	KindYtDlp     Kind = "yt-dlp"
	KindFFmpeg    Kind = "ffmpeg"
	KindFFprobe   Kind = "ffprobe"
	KindGalleryDl Kind = "gallery-dl"
	KindDeno      Kind = "deno"
)

// Kinds lists all dependencies; order is the UI display order
var Kinds = []Kind{KindYtDlp, KindFFmpeg, KindFFprobe, KindGalleryDl, KindDeno}

// Optional marks non-required dependencies: ffprobe is only used in some post-processing;
// gallery-dl is yt-dlp's fallback engine (missing it only affects image downloads);
// deno is only needed for YouTube downloads (POT service).
var Optional = map[Kind]bool{KindFFprobe: true, KindGalleryDl: true, KindDeno: true}

// BinaryName is the tool's file name on disk
func BinaryName(kind Kind) string {
	if runtime.GOOS == "windows" {
		return string(kind) + ".exe"
	}
	return string(kind)
}

// Source is where a dependency came from, for UI labels and troubleshooting
type Source string

const (
	SourceManaged Source = "managed" // downloaded into userData by DownPilot
	SourceSystem  Source = "system"  // system install (PATH / common dirs)
	SourceManual  Source = "manual"  // user-specified in Settings
	SourceScanned Source = "scanned" // found by the fallback full scan (not in a known location)
)

// Options is the input for detection
type Options struct {
	ManagedDir  string          // managed dir, e.g. <userData>/runtime/bin
	ManualPaths map[Kind]string // user-specified absolute paths
}

// Result is one dependency's detection result. When Found=false, Reason explains why not.
type Result struct {
	Kind     string `json:"kind"`
	Found    bool   `json:"found"`
	Optional bool   `json:"optional,omitempty"`
	Path     string `json:"path,omitempty"`
	Version  string `json:"version,omitempty"`
	Source   string `json:"source,omitempty"`
	Reason   string `json:"reason,omitempty"`
	Managed  bool   `json:"managed,omitempty"` // this dep is managed by DownPilot and safe to overwrite on update
	// RequiredVersion is the minimum version the current manifest requires. The UI uses it to decide
	// whether an "update" prompt is really warranted: it used to show "update" whenever Managed
	// was true, so users saw "update" even when the version already matched the manifest —
	RequiredVersion string `json:"requiredVersion,omitempty"`
	// Stale means "found a usable copy, but its version lags the manifest". Only when
	// Found=false + Stale=true should the UI actively guide the user to update.
	Stale bool `json:"stale,omitempty"`
}

// and downloaded 37MB for nothing.

// FindAll detects all dependencies in order
func FindAll(opts Options) []Result {
	ctx, cancel := context.WithTimeout(context.Background(), DetectTimeout)
	defer cancel()
	return FindAllContext(ctx, opts)
}

// DetectTimeout is below Electron's 90s timeout, leaving margin for the JSON round-trip.
//
// The total budget must fit the worst path within a single dependency: 15s for the managed copy
// (see probe.CandidateTimeout — yt-dlp's official macOS build measured 12.4s at slowest on first run)
// + 18s for the fallback scan (see scanTimeLimit) = 33s, still far below 80.
//
// This is the SINGLE source of the total timeout: the Electron side deliberately no longer passes
// --timeout (it once hard-coded 70s and overrode this, silently contradicting the documented 80).
const DetectTimeout = 80 * time.Second

func FindAllContext(ctx context.Context, opts Options) []Result {
	results := make([]Result, 0, len(Kinds))
	for _, kind := range Kinds {
		results = append(results, findOneContext(ctx, kind, opts))
	}
	return results
}

// FindOne detects a single dependency (used to re-read results after a download)
func FindOne(kind Kind, opts Options) Result { return findOne(kind, opts) }

func findOne(kind Kind, opts Options) Result {
	return findOneContext(context.Background(), kind, opts)
}

func findOneContext(parent context.Context, kind Kind, opts Options) Result {
	ctx, cancel := context.WithTimeout(parent, probeTimeLimit)
	defer cancel()
	res := Result{Kind: string(kind), Optional: Optional[kind]}
	// Reset scan budget and deadline: each dependency gets its own, so one can't drain the next
	resetScanBudget()
	resetProbeBudget()

	// When recording failure reasons, keep the MOST informative one:
	// "version too old" matters far more than "some candidate path doesn't exist", but the latter
	// always comes last — using lastErr directly would bury the former (user only sees stat no such file).
	var staleErr error // found the file but the version is too old
	staleSeen := false // at least one copy was rejected for being too old
	var probeErr error // found the file but it failed to run (corrupt, no permission, etc.)
	var lastErr error  // everything else (path doesn't exist, etc.)
	for _, c := range candidatesFor(kind, opts) {
		if ctx.Err() != nil {
			break
		}
		// A stuck candidate eats one candidate budget each; without this gate, a dozen candidates
		// could drag one dependency out for minutes. Stop at the total budget — better to
		// under-report than to leave the UI spinning forever.
		if probeBudgetExhausted() {
			break
		}
		info, err := probeToolCandidate(ctx, kind, c)
		if err != nil {
			if _, statErr := os.Stat(c.Path); statErr == nil {
				probeErr = err // file exists but won't run — worth showing
			} else {
				lastErr = err // path doesn't exist — least informative
			}
			continue
		}
		if !isAcceptableVersion(kind, info) {
			staleErr = staleReason(kind, info)
			staleSeen = true
			continue
		}
		res.Found = true
		res.Path = info.Path
		res.Version = info.Version
		res.Source = string(c.Source)
		res.Managed = c.Source == SourceManaged
		res.RequiredVersion = requiredVersion(kind)
		return res
	}

	// Fallback: when no known dir hit, do one BOUNDED full scan.
	//
	// Why it's needed: candidate dirs are enumerated, so they miss portable installs, custom
	// install dirs, or wherever some future package manager decides to put things. In those cases
	// the user clearly has it installed but we'd report it missing, with nothing to act on.
	//
	// Why it must be bounded: a full walk can take very long on Windows (and hits network drives).
	// So only scan a few most-likely roots, limit depth and visited entries, stop on first hit.
	// The scan budget starts counting at scan start — earlier version probes must not consume it.
	resetScanBudget()
	if deadline, ok := ctx.Deadline(); ok && deadline.Before(scanDeadline) {
		scanDeadline = deadline
	}
	if fallback := scanForBinary(ctx, kind); fallback != nil {
		res.Found = true
		res.Path = fallback.Path
		res.Version = fallback.Version
		res.Source = string(SourceScanned)
		res.Managed = false
		return res
	}

	res.RequiredVersion = requiredVersion(kind)
	res.Stale = staleSeen

	switch {
	case ctx.Err() != nil:
		res.Reason = "dependency detection timed out; specify the executable path manually and retry"
	case staleErr != nil:
		// "Version too old" is far more informative than "some path doesn't exist" — show it first
		res.Reason = staleErr.Error()
	case probeErr != nil:
		res.Reason = probeErr.Error()
	case lastErr != nil && !isNotExist(lastErr):
		res.Reason = lastErr.Error()
	default:
		res.Reason = "not found in the managed dir, PATH, or common install dirs (common locations were scanned)"
	}
	return res
}

// requiredVersion returns the minimum version the manifest currently requires for a dep; "" if not injected.
//
// It's factored out because it must appear on EVERY return path: the UI uses it to tell
// "installed but too old" apart from "installed at the required version" — the latter must not prompt an update.
func requiredVersion(kind Kind) string {
	return MinVersions[kind]
}

// isNotExist tells whether an error is merely "path doesn't exist" — such reasons have no
// diagnostic value; showing them would crowd out the real cause (too old, corrupt file)
func isNotExist(err error) bool {
	return errors.Is(err, os.ErrNotExist) || strings.Contains(err.Error(), "no such file or directory")
}

// probeTimeoutMarker must stay in sync with probe's timeout wording (probe.describeRunError).
// A string, not an error type, because a timeout can come from probe's own sub-timeout
// or from an upstream ctx cancel — both are wrapped as errors.New.
const probeTimeoutMarker = "execution timed out"

// isProbeTimeout tells whether an error is a timeout (as opposed to corrupt / no permission / bad format)
func isProbeTimeout(err error) bool {
	return err != nil && strings.Contains(err.Error(), probeTimeoutMarker)
}

// probeTimeLimit is the total budget for executing candidate files WITHIN one dependency.
//
// Why this gate exists: stuck candidates each eat a candidate budget, and the candidate list can hold
// a dozen paths (PATH + common install dirs per platform) — worst case drags one dep out for minutes.
//
// Value: 15s for the managed copy (slowest measured first run: 12.4s) + several 5s system candidates.
// This is an UPPER BOUND, not the typical case: normally the managed copy hits and it's over.
const probeTimeLimit = 45 * time.Second

// probeDeadline is the wall-clock cap for probing candidates in one pass, set by findOne before each pass.
var probeDeadline time.Time

// resetProbeBudget resets the candidate-execution budget. Like resetScanBudget it's package-level state;
// factored into a function so tests can reset it explicitly (otherwise cases affect each other — see the scan lesson).
func resetProbeBudget() {
	probeDeadline = time.Now().Add(probeTimeLimit)
}

// probeBudgetExhausted tells whether the candidate-execution budget is exhausted. Zero means no limit.
func probeBudgetExhausted() bool {
	if probeDeadline.IsZero() {
		return false
	}
	return time.Now().After(probeDeadline)
}

// scanForBinary searches common roots for the executable, within limits.
//
// Only as a fallback: reached after the normal paths (managed dir / PATH / common dirs) were all tried.
// Hits are marked SourceScanned; the UI shows "auto-scan found" so users can judge the source.
func scanForBinary(ctx context.Context, kind Kind) *probe.Info {
	name := BinaryName(kind)
	seen := map[string]bool{}
	var result *probe.Info

	for _, root := range scanRoots() {
		if seen[root] {
			continue
		}
		seen[root] = true

		found := scanDirMatching(root, name, 0, func(file string) bool {
			probeCtx, cancel := context.WithDeadline(ctx, scanDeadline)
			defer cancel()
			info, err := probeToolContext(probeCtx, kind, file)
			if err != nil || !isAcceptableVersion(kind, info) {
				return false
			}
			result = &info
			return true
		})
		if found != "" {
			return result
		}
	}
	return nil
}

// scanDir looks for name under dir, at most maxDepth levels deep.
//
// Limits:
//   - depth (default 4): reaches `.../bin/yt-dlp`, `.../ffmpeg/bin/ffmpeg.exe` style layouts
//   - dir budget: what really decides cost is the number of DIRECTORIES RECURSED INTO (each ReadDir is a syscall),
//     not how many files a single dir holds
//   - skip obviously irrelevant dirs (node_modules, caches, system dirs)
func scanDir(dir string, name string, depth int) string {
	return scanDirMatching(dir, name, depth, func(string) bool { return true })
}

// An invalid or outdated same-named file must not shadow other copies in the same tree.
func scanDirMatching(dir string, name string, depth int, accept func(string) bool) string {
	// Three gates: depth, dir budget, and a wall-clock cap.
	// The time cap exists because the dir budget can't bound "every single dir is slow"
	// (on Windows, Program Files + antivirus scanning can make one ReadDir take hundreds of ms).
	// Without it, the "fallback scan" could itself surface as "dependency detection timed out".
	if depth > scanMaxDepth || scanDirsLeft <= 0 || scanExpired(time.Now()) {
		return ""
	}
	scanDirsLeft--

	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}

	var subdirs []string
	for _, e := range entries {
		full := filepath.Join(dir, e.Name())

		if e.IsDir() {
			if shouldSkipDir(e.Name()) {
				continue
			}
			subdirs = append(subdirs, full)
			continue
		}

		// Hit: file name matches exactly (case-insensitive on Windows)
		if strings.EqualFold(e.Name(), name) && accept(full) {
			return full
		}
	}

	for _, sub := range subdirs {
		if found := scanDirMatching(sub, name, depth+1, accept); found != "" {
			return found
		}
	}
	return ""
}

const scanMaxDepth = 4

// scanDirsLeft caps how many directories a single scan may ENTER.
//
// Deliberately counted by dirs, not entries: it used to count entries (20000), and on Windows
// a single big dir like `C:\Program Files` exhausted the budget, making the fallback scan useless
// — the CI windows job is exactly what exposed this.
//
// Reset before each dependency is probed.
var scanDirsLeft = scanMaxDirs

// scanMaxDirs caps how many dirs a single scan may enter
const scanMaxDirs = 3000

// scanDeadline is the wall-clock cap for one scan, set by findOne before each probe.
var scanDeadline time.Time

// scanTimeLimit caps how long one scan may take. Better to miss than to time the detection out.
//
// Must be GREATER than probe.CandidateTimeout: otherwise the first executable the scan hits
// (e.g. the just-downloaded managed copy, slowest measured first run 12.4s) would always be
// cut off by the scan deadline, and the fallback scan could never find it. CandidateTimeout + one candidate's margin.
const scanTimeLimit = 18 * time.Second

// resetScanBudget resets the scan dir budget and deadline.
//
// Factored out so tests can explicitly reset global state: these two vars are package-level mutable state,
// and cases affect each other (CI once had "the previous case set the deadline in the past"
// silently failing the next case).
func resetScanBudget() {
	scanDirsLeft = scanMaxDirs
	scanDeadline = time.Now().Add(scanTimeLimit)
}

// scanExpired tells whether the scan has timed out.
//
// **Zero must mean "no deadline", not "expired"**: with time.Time's zero value,
// `now.After(zero)` is always true, which would make the scan silently do nothing.
// CI caught this pitfall — cases calling scanDir directly (without findOne setting a deadline)
// failed on Windows (slower, easier to hit).
func scanExpired(now time.Time) bool {
	if scanDeadline.IsZero() {
		return false
	}
	return now.After(scanDeadline)
}

// shouldSkipDir skips dirs that obviously can't hold executables, or are too big
func shouldSkipDir(name string) bool {
	switch strings.ToLower(name) {
	case "node_modules", ".git", ".cache", "cache", "caches", "logs", "tmp", "temp",
		"windows", "system32", "winsxs", "$recycle.bin", "appdata":
		return true
	}
	return false
}

// scanRoots returns scan roots, ordered by likelihood.
//
// Only places "where users put things themselves" — never whole disk roots (walking C:\ on Windows is too slow).
func scanRoots() []string {
	home, _ := os.UserHomeDir()
	var roots []string

	if home != "" {
		roots = append(roots,
			filepath.Join(home, "Downloads"),
			filepath.Join(home, "Desktop"),
			filepath.Join(home, "Documents"),
			filepath.Join(home, "bin"),
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, "scoop", "apps"),
			filepath.Join(home, "AppData", "Local", "Programs"),
		)
	}

	switch runtime.GOOS {
	case "darwin":
		roots = append(roots, "/opt/homebrew/bin", "/usr/local/bin", "/Applications", "/opt/local/bin")
	case "linux":
		roots = append(roots, "/usr/local/bin", "/usr/bin", "/opt", "/snap/bin")
	case "windows":
		local := envDir("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
		roots = append(roots,
			filepath.Join(local, "Programs"),
			envDir("SCOOP", filepath.Join(home, "scoop")),
			envDir("SCOOP_GLOBAL", filepath.Join(envDir("ProgramData", `C:\ProgramData`), "scoop")),
			envDir("ProgramFiles", `C:\Program Files`),
			envDir("ProgramFiles(x86)", `C:\Program Files (x86)`),
			`C:\tools`,
			`C:\ffmpeg`,
		)
	}
	return roots
}

// MinVersions holds each dep's minimum usable version, injected by the CLI.
//
// Why this package doesn't read the manifest directly: `manifest` imports this package (for platform keys),
// and a reverse import would create an import cycle. So the CLI (which sees both) injects them.
//
// **yt-dlp's value is the manifest-pinned tag**: it uses date versions, and site fixes ship weekly,
// so judging by year is too lax — the 2026.08.19 build was observed failing YouTube with
// `Requested format is not available` (upstream fixed the same class of issue in a newer build),
// while a year-based check would "pass" it — leaving users stuck on a build that can't run.
var MinVersions = map[Kind]string{}

// isAcceptableVersion decides whether a detected version is usable
func isAcceptableVersion(kind Kind, info probe.Info) bool {
	if min, ok := MinVersions[kind]; ok && min != "" {
		return !probe.IsOlder(info.Version, min)
	}
	// Without an injected threshold, fall back to the coarse check (by major version)
	if min, ok := probe.MinimumMajor[string(kind)]; ok {
		return info.Major >= min
	}
	return true
}

// staleReason builds the "version too old" message, with current and required versions for the user to judge
func staleReason(kind Kind, info probe.Info) error {
	if min, ok := MinVersions[kind]; ok && min != "" {
		return errors.New("version too old (current " + info.Version + ", need " + min +
			" or newer); re-download under \u201cSettings \u2192 Runtime dependencies\u201d")
	}
	return errors.New("version too old (" + info.Version + "); re-download is recommended")
}

// ===== candidate paths =====

type candidate struct {
	Path   string
	Source Source
}

func candidatesFor(kind Kind, opts Options) []candidate {
	name := BinaryName(kind)
	list := make([]candidate, 0, 16)
	add := func(dir string, source Source) {
		if dir == "" {
			return
		}
		list = append(list, candidate{Path: filepath.Join(dir, name), Source: source})
	}

	if p := opts.ManualPaths[kind]; p != "" {
		list = append(list, candidate{Path: p, Source: SourceManual})
	}
	add(opts.ManagedDir, SourceManaged)
	for _, dir := range systemDirs() {
		add(dir, SourceSystem)
	}
	return dedupe(list)
}

func dedupe(list []candidate) []candidate {
	seen := make(map[string]struct{}, len(list))
	out := make([]candidate, 0, len(list))
	for _, c := range list {
		key := filepath.Clean(c.Path)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, candidate{Path: key, Source: c.Source})
	}
	return out
}

func probeTool(kind Kind, path string) (probe.Info, error) {
	return probeToolContext(context.Background(), kind, path)
}

func probeToolContext(ctx context.Context, kind Kind, path string) (probe.Info, error) {
	return probeToolCandidate(ctx, kind, candidate{Path: path, Source: SourceSystem})
}

// probeToolCandidate picks the execution timeout by candidate source.
//
// The managed copy is our own download of the official build (PyInstaller, slowest measured first run 12.4s),
// so it gets a generous budget; system copies are usually 0.2s zipapps, so give up fast when stuck —
// the candidate list can hold a dozen paths, and 15s each would drag one detection out for minutes.
func probeToolCandidate(ctx context.Context, kind Kind, c candidate) (probe.Info, error) {
	if _, err := os.Stat(c.Path); err != nil {
		return probe.Info{Path: c.Path}, err
	}
	timeout := probe.SystemCandidateTimeout
	if c.Source == SourceManaged {
		timeout = probe.CandidateTimeout
	}
	return probe.RunWithTimeout(ctx, string(kind), c.Path, timeout)
}

// ===== PATH resolution =====

var (
	shellPathsOnce sync.Once
	shellPaths     []string
)

// systemDirs returns the login shell's PATH, the current PATH, and common install dirs per platform
func systemDirs() []string {
	dirs := filepath.SplitList(livePath())
	dirs = append(dirs, commonInstallDirs()...)

	filtered := make([]string, 0, len(dirs))
	for _, d := range dirs {
		d = strings.TrimSpace(d)
		// A packaged app puts its own dir into PATH — exclude it to avoid false hits
		if d == "" || strings.Contains(d, "app.asar") {
			continue
		}
		filtered = append(filtered, filepath.Clean(d))
	}
	return filtered
}

// livePath merges the current process PATH with the login shell's PATH.
//
// GUI apps launched from Finder/desktop on macOS/Linux only get a trimmed PATH
// (missing /opt/homebrew/bin, ~/.local/bin, etc.), so supplement it with the login shell's output.
func livePath() string {
	current := os.Getenv("PATH")
	if runtime.GOOS != "windows" {
		shellPathsOnce.Do(func() { shellPaths = loginShellPath() })
		if len(shellPaths) > 0 {
			current += string(os.PathListSeparator) + strings.Join(shellPaths, string(os.PathListSeparator))
		}
	}
	return current
}

func loginShellPath() []string {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	// -l loads the user's rc files; give up on timeout instead of blocking detection
	out, err := outputWithTimeout(exec.Command(shell, "-l", "-c", `printf %s "$PATH"`), 3*time.Second)
	if err != nil {
		return nil
	}
	return filepath.SplitList(strings.TrimSpace(string(out)))
}

// expandWindowsGlobs expands wildcard paths under WinGet\Packages.
//
// Dir names there carry random hashes (yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe),
// so they can't be hard-coded — list and match by prefix instead.
func expandWindowsGlobs(base string, patterns []string) []string {
	var out []string
	for _, pattern := range patterns {
		matches, err := filepath.Glob(filepath.Join(base, pattern))
		if err != nil {
			continue
		}
		out = append(out, matches...)
	}
	return out
}

func commonInstallDirs() []string {
	home, _ := os.UserHomeDir()
	var dirs []string

	switch runtime.GOOS {
	case "darwin":
		dirs = []string{
			"/opt/homebrew/bin", "/opt/homebrew/sbin",
			"/usr/local/bin", "/usr/local/sbin",
			"/opt/local/bin", "/opt/local/sbin",
			"/Library/Apple/usr/bin",
			"/usr/bin", "/bin", "/usr/sbin", "/sbin",
			"/Applications/yt-dlp.app/Contents/MacOS",
		}
	case "linux":
		dirs = []string{
			"/usr/local/bin", "/usr/local/sbin",
			"/usr/bin", "/bin", "/usr/sbin", "/sbin",
			"/snap/bin",
			"/var/lib/flatpak/exports/bin",
			"/usr/lib/yt-dlp/bin", "/usr/local/lib/yt-dlp/bin",
			"/app/bin", // inside the Flatpak sandbox
		}
	case "windows":
		dirs = windowsInstallDirs(home)
		return append(dirs, extraDirs(home)...)
	}

	if home != "" {
		dirs = append(dirs, filepath.Join(home, "bin"), filepath.Join(home, ".local", "bin"))
	}
	return dirs
}

// windowsInstallDirs returns candidate dirs on Windows.
//
// Factored as a pure function taking home so Windows paths can be tested ON MACOS —
// reading os.UserHomeDir directly would only ever show macOS paths locally, i.e. untested
// (that's exactly how the platform-key bug slipped through).
func windowsInstallDirs(home string) []string {
	// winget's landing spots (from the winget manifest + actual install results, not guessed):
	//   - WinGet\Links: portable packages (yt-dlp.yt-dlp) symlink the exe here
	//   - WinGet\Packages: the actually-extracted dir, with package name + random hash in the path
	//   - yt-dlp.FFmpeg is zip + nested portable, extracting to
	//     <hash>\ffmpeg-N-xxxx-win64-gpl\bin\{ffmpeg,ffprobe}.exe
	//   - DenoLand.Deno provides the JS runtime (yt-dlp's manifest lists it as a dependency)
	local := envDir("LOCALAPPDATA", filepath.Join(home, "AppData", "Local"))
	programFiles := envDir("ProgramFiles", `C:\Program Files`)
	programData := envDir("ProgramData", `C:\ProgramData`)
	scoop := envDir("SCOOP", filepath.Join(home, "scoop"))
	scoopGlobal := envDir("SCOOP_GLOBAL", filepath.Join(programData, "scoop"))
	wingetBase := filepath.Join(local, "Microsoft", "WinGet")

	// winget has TWO landing spots: user-level and machine-level (`--scope machine`).
	// Covering only user-level would report "installed as admin" users as missing.
	machineBase := filepath.Join(programFiles, "WinGet")

	dirs := []string{
		filepath.Join(envDir("ChocolateyInstall", filepath.Join(programData, "chocolatey")), "bin"),
		filepath.Join(programFiles, "yt-dlp"),
		filepath.Join(envDir("ProgramFiles(x86)", `C:\Program Files (x86)`), "yt-dlp"),
		`C:\ffmpeg\bin`,
		filepath.Join(programFiles, "ffmpeg", "bin"),
		filepath.Join(scoop, "shims"),
		filepath.Join(scoop, "apps", "yt-dlp", "current"),
		filepath.Join(scoop, "apps", "ffmpeg", "current", "bin"),
		filepath.Join(scoopGlobal, "shims"),
		filepath.Join(scoopGlobal, "apps", "yt-dlp", "current"),
		filepath.Join(scoopGlobal, "apps", "ffmpeg", "current", "bin"),
		// user-level winget
		filepath.Join(wingetBase, "Links"),
		// machine-level winget (--scope machine)
		filepath.Join(machineBase, "Links"),
		filepath.Join(local, "Microsoft", "WindowsApps"),
	}

	// Dir names under Packages contain random hashes — expand wildcards; both user and machine level
	dirs = append(dirs, expandWindowsGlobs(wingetBase, WindowsPackagePatterns)...)
	dirs = append(dirs, expandWindowsGlobs(machineBase, WindowsPackagePatterns)...)

	return dirs
}

func envDir(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

// WindowsPackagePatterns are the wildcard patterns to expand under WinGet\Packages.
//
// Joining with filepath.Join instead of hard-coding backslashes has two benefits:
//  1. correct `\` separators on Windows (filepath.Glob matches with the host separator)
//  2. `/` on macOS, so a fake dir tree can GENUINELY verify the expansion logic
//     — with hard-coded backslashes, local runs only ever saw "empty expansion", i.e. untested
var WindowsPackagePatterns = []string{
	// yt-dlp.yt-dlp is a portable package; the extracted exe sits directly in the package dir
	filepath.Join("Packages", "yt-dlp.yt-dlp_*"),
	// yt-dlp.FFmpeg is zip + nested portable, with one more extract dir + bin layer
	filepath.Join("Packages", "yt-dlp.FFmpeg_*"),
	filepath.Join("Packages", "yt-dlp.FFmpeg_*", "*", "bin"),
	// DenoLand.Deno provides the JS runtime (yt-dlp's manifest lists it as a dependency)
	filepath.Join("Packages", "DenoLand.Deno_*"),
	// the case where the user installed Gyan.FFmpeg directly
	filepath.Join("Packages", "Gyan.FFmpeg_*"),
	filepath.Join("Packages", "Gyan.FFmpeg_*", "*", "bin"),
}

// extraDirs are user-level dirs that apply cross-platform
func extraDirs(home string) []string {
	if home == "" {
		return nil
	}
	return []string{filepath.Join(home, "bin"), filepath.Join(home, ".local", "bin")}
}

func outputWithTimeout(cmd *exec.Cmd, timeout time.Duration) ([]byte, error) {
	type result struct {
		out []byte
		err error
	}
	ch := make(chan result, 1)
	go func() {
		out, err := cmd.Output()
		ch <- result{out, err}
	}()
	select {
	case r := <-ch:
		return r.out, r.err
	case <-time.After(timeout):
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		<-ch
		return nil, errors.New("timeout")
	}
}
