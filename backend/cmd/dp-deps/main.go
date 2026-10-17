// Command dp-deps is DownPilot's dependency detection and download sidecar.
//
// DownPilot no longer bundles yt-dlp / ffmpeg binaries: the installer ships only this program;
// at startup it detects already-installed dependencies on the machine and reuses them directly,
//
// and the user downloads whatever is missing with one click.
//
// Output contract: stdout is an NDJSON event stream (parsed line-by-line by Electron), stderr is human-readable logs.
//
// Usage:
//
//	dp-deps detect  --managed-dir <dir> [--manual yt-dlp=<path>] [--json]
//	dp-deps fetch   --managed-dir <dir> [--only yt-dlp,ffmpeg] [--proxy <url>] [--force]
//	dp-deps version
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/ShahzaibRao/downpilot/backend/internal/cli"
	"github.com/ShahzaibRao/downpilot/backend/internal/fetch"
	"github.com/ShahzaibRao/downpilot/backend/internal/manifest"
	rt "github.com/ShahzaibRao/downpilot/backend/internal/runtime"
)

// Version build number, decided by package.json's download backend version
const Version = "1.0.0"

func main() {
	// Inject the manifest-pinned versions into runtime as minimum thresholds.
	// This lives here because runtime cannot import manifest (would create an import cycle),
	// while the CLI depends on both.
	rt.MinVersions[rt.KindYtDlp] = manifest.MinYtDlpVersion()
	rt.MinVersions[rt.KindGalleryDl] = manifest.MinGalleryDlVersion()
	rt.MinVersions[rt.KindDeno] = manifest.MinDenoVersion()

	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "detect":
		runDetect(os.Args[2:])
	case "fetch", "download":
		runFetch(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Println("dp-deps", Version, manifest.CurrentPlatform())
	case "help", "--help", "-h":
		usage()
	default:
		cli.Fail("unknown subcommand: " + os.Args[1])
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `dp-deps — DownPilot dependency detection and download

  detect  Probe yt-dlp / ffmpeg / ffprobe / gallery-dl / deno, output JSON results
  fetch   Download missing dependencies into the managed dir (SHA-256 verified)
  version Print version and platform

detect flags:
  --managed-dir <dir>     Managed dir (where downloads are installed)
  --manual <kind>=<path>  Manually specified executable path, repeatable
  --json                  Single-line JSON output (default is event stream)
  --timeout <sec>          Total detection timeout, default 80 (falls back to rt.DetectTimeout)

fetch flags:
  --managed-dir <dir>     Managed dir (required)
  --only <a,b>            Only download the given deps, comma-separated (default: all)
  --proxy <url>           Proxy for downloads
  --force                 Re-download even if already present
  --timeout <sec>          Per-request timeout, default 1800
`)
}

// ===== detect =====

type detectRequest struct {
	ManagedDir string            `json:"managedDir"`
	Manual     map[string]string `json:"manual"`
}

func runDetect(args []string) {
	fs := flag.NewFlagSet("detect", flag.ExitOnError)
	managedDir := fs.String("managed-dir", "", "managed dir")
	jsonOutput := fs.Bool("json", false, "single-line JSON output")
	timeout := fs.Int("timeout", int(rt.DetectTimeout/time.Second), "total detection timeout (seconds)")
	var manual manualFlags
	fs.Var(&manual, "manual", "manually specify path as kind=path, repeatable")
	// Accept both --manual-dir and --manual-path as equivalents
	_ = fs.Parse(args)

	manualPaths := make(map[rt.Kind]string, len(manual))
	for kind, path := range manual {
		manualPaths[rt.Kind(kind)] = path
	}
	opts := rt.Options{ManagedDir: *managedDir, ManualPaths: manualPaths}
	if *timeout <= 0 {
		cli.Fail("detection timeout must be greater than 0")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(*timeout)*time.Second)
	defer cancel()
	results := rt.FindAllContext(ctx, opts)

	payload := map[string]any{
		"event":    "detect",
		"platform": manifest.CurrentPlatform(),
		// Also print Go's naming to help diagnose "platform key doesn't match asset table" issues
		// (this once broke dependency downloads on all x64 platforms, see issue #40)
		"goPlatform": runtime.GOOS + "/" + runtime.GOARCH,
		"managedDir": *managedDir,
		"results":    results,
	}

	if *jsonOutput {
		encoded, _ := json.Marshal(payload)
		fmt.Println(string(encoded))
		return
	}
	cli.Emit(payload)
	for _, r := range results {
		if r.Found {
			cli.Log(fmt.Sprintf("%s ready: %s (%s, %s)", r.Kind, r.Version, r.Source, r.Path))
		} else {
			cli.Log(fmt.Sprintf("%s missing: %s", r.Kind, r.Reason))
		}
	}
}

// ===== fetch =====

func runFetch(args []string) {
	fs := flag.NewFlagSet("fetch", flag.ExitOnError)
	managedDir := fs.String("managed-dir", "", "managed dir (required)")
	only := fs.String("only", "", "only download the given deps, comma-separated")
	proxy := fs.String("proxy", "", "download proxy")
	force := fs.Bool("force", false, "re-download even if present")
	timeout := fs.Int("timeout", 1800, "per-request timeout (seconds)")
	_ = fs.Parse(args)

	if *managedDir == "" {
		cli.Fail("fetch requires the --managed-dir flag")
	}

	var onlyList []string
	for _, item := range strings.Split(*only, ",") {
		if trimmed := strings.TrimSpace(item); trimmed != "" {
			onlyList = append(onlyList, trimmed)
		}
	}

	tasks, err := manifest.Tasks(*managedDir, onlyList)
	if err != nil {
		cli.Fail(err.Error())
	}

	// Without --force, skip deps that already exist and are executable
	if !*force {
		tasks = filterMissing(tasks, *managedDir)
	}
	if len(tasks) == 0 {
		cli.Emit(map[string]any{"event": "done", "skipped": true, "message": "dependencies already present, nothing to download"})
		cli.Log("all dependencies already present, skipping download")
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	emit := func(e fetch.Event) {
		cli.Emit(e)
		if e.Event == "progress" {
			return
		}
		if e.Message != "" {
			cli.Log(e.Tool + " " + e.Event + "：" + e.Message)
		} else {
			cli.Log(e.Tool + " " + e.Event)
		}
	}

	summary := make([]fetch.Event, 0, 8)
	err = fetch.Install(ctx, tasks, fetch.Options{
		Proxy:   *proxy,
		Timeout: time.Duration(*timeout) * time.Second,
		Emit:    emit,
	})
	if err != nil {
		cli.Fail(err.Error())
	}

	// Post-install platform handling (macOS: clear quarantine attrs + ad-hoc sign)
	for _, task := range tasks {
		fetch.Finalize(task.Target, fetch.Options{}, emit)
		summary = append(summary, fetch.Event{Event: "installed", Tool: task.Tool, Path: task.Target})
	}

	// Re-read the just-installed versions so the UI can display them immediately
	opts := rt.Options{ManagedDir: *managedDir}
	results := make([]rt.Result, 0, len(tasks))
	for _, task := range tasks {
		results = append(results, rt.FindOne(rt.Kind(task.Tool), opts))
	}
	cli.Emit(map[string]any{"event": "done", "installed": summary, "results": results})
	cli.Log("dependency installation complete")
}

// filterMissing keeps only deps that are not yet installed (or not executable at their location)
func filterMissing(tasks []fetch.Task, managedDir string) []fetch.Task {
	opts := rt.Options{ManagedDir: managedDir}
	keep := make([]fetch.Task, 0, len(tasks))
	for _, task := range tasks {
		res := rt.FindOne(rt.Kind(task.Tool), opts)
		if res.Found && res.Managed {
			cli.Log(task.Tool + " already present, skipping")
			continue
		}
		keep = append(keep, task)
	}
	return keep
}

// manualFlags supports repeated --manual kind=path flags
type manualFlags map[string]string

func (m *manualFlags) String() string {
	if m == nil {
		return ""
	}
	parts := make([]string, 0, len(*m))
	for k, v := range *m {
		parts = append(parts, k+"="+v)
	}
	return strings.Join(parts, ",")
}

func (m *manualFlags) Set(value string) error {
	key, val, ok := strings.Cut(value, "=")
	if !ok {
		return fmt.Errorf("expected format kind=path, got %q", value)
	}
	if *m == nil {
		*m = map[string]string{}
	}
	(*m)[strings.TrimSpace(key)] = strings.TrimSpace(val)
	return nil
}
