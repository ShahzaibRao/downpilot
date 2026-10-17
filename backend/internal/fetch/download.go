// Package fetch downloads and installs yt-dlp / ffmpeg / ffprobe / gallery-dl / deno into the managed dir.
//
// Downloads land in a temp file and go through SHA-256 verification; only after passing
// do they get extracted and atomically renamed, so a network blip or corrupt mirror
package fetch

import (
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

// can never leave a half-installed executable behind.

// Event is a progress event; the CLI prints them as NDJSON, one per line
type Event struct {
	Event      string `json:"event"`
	Tool       string `json:"tool,omitempty"`
	Downloaded int64  `json:"downloaded,omitempty"`
	Total      int64  `json:"total,omitempty"`
	Path       string `json:"path,omitempty"`
	Message    string `json:"message,omitempty"`
}

// Emitter receives progress events
type Emitter func(Event)

// Task is a single install job
type Task struct {
	Tool   string // yt-dlp / ffmpeg / ffprobe / gallery-dl / deno
	URL    string
	SHA256 string // checksum of the downloaded bytes (of the archive itself when gzip/zip)
	Gzip   bool
	// When Zip is true, extract a single file from the zip; ZipInner is the in-archive path
	// (empty means the first file in the archive). Mutually exclusive with Gzip.
	Zip      bool
	ZipInner string
	Target   string // final install path
}

// Options are download options
type Options struct {
	Proxy      string
	Timeout    time.Duration
	Retries    int
	HTTPClient *http.Client
	Emit       Emitter
	// SkipSign skips the macOS ad-hoc signing (for tests)
	SkipSign bool
}

func (o *Options) emit(e Event) {
	if o.Emit != nil {
		o.Emit(e)
	}
}

func (o *Options) client() (*http.Client, error) {
	if o.HTTPClient != nil {
		return o.HTTPClient, nil
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if o.Proxy != "" {
		u, err := url.Parse(o.Proxy)
		if err != nil {
			return nil, fmt.Errorf("invalid proxy address: %w", err)
		}
		transport.Proxy = http.ProxyURL(u)
	} else {
		transport.Proxy = http.ProxyFromEnvironment
	}
	timeout := o.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	return &http.Client{Transport: transport, Timeout: timeout}, nil
}

// Install runs all tasks in order; returns on the first failure, keeping completed tasks
func Install(ctx context.Context, tasks []Task, opts Options) error {
	if len(tasks) == 0 {
		return errors.New("no dependencies to download")
	}
	client, err := opts.client()
	if err != nil {
		return err
	}
	opt := opts
	opt.HTTPClient = client

	for _, task := range tasks {
		opt.emit(Event{Event: "start", Tool: task.Tool})
		if err := installOne(ctx, task, opt); err != nil {
			opt.emit(Event{Event: "error", Tool: task.Tool, Message: err.Error()})
			return fmt.Errorf("%s：%w", task.Tool, err)
		}
		opt.emit(Event{Event: "installed", Tool: task.Tool, Path: task.Target})
	}
	return nil
}

func installOne(ctx context.Context, task Task, opts Options) error {
	if task.Target == "" {
		return errors.New("install path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(task.Target), 0o755); err != nil {
		return fmt.Errorf("failed to create directory: %w", err)
	}

	// Download to a temp file first; atomically replace the target only after verify/extract
	staging := task.Target + ".part"
	if task.Gzip {
		staging += ".gz"
	}
	if task.Zip {
		staging += ".zip"
	}
	_ = os.Remove(staging)
	defer os.Remove(staging)

	retries := opts.Retries
	if retries <= 0 {
		retries = 3
	}

	var lastErr error
	for attempt := 1; attempt <= retries; attempt++ {
		if attempt > 1 {
			opts.emit(Event{Event: "retry", Tool: task.Tool, Message: fmt.Sprintf("retry %d", attempt)})
			select {
			case <-time.After(time.Duration(attempt-1) * 2 * time.Second):
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		lastErr = fetchOnce(ctx, task, staging, opts)
		if lastErr == nil {
			break
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
	if lastErr != nil {
		return lastErr
	}
	return promote(task, staging)
}

// fetchOnce downloads and verifies into staging; for gzip the checksum covers the archive itself
func fetchOnce(ctx context.Context, task Task, staging string, opts Options) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, task.URL, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", "DownPilot (+https://github.com/ShahzaibRao/downpilot)")

	res, err := opts.HTTPClient.Do(req)
	if err != nil {
		return fmt.Errorf("network request failed: %s%s", sanitizeURL(err.Error()), networkHint(err))
	}
	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("download failed: HTTP %d %s", res.StatusCode, res.Status)
	}

	file, err := os.Create(staging)
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}

	hasher := sha256.New()
	counter := newProgressCounter(task.Tool, res.ContentLength, opts.emit)
	_, copyErr := io.Copy(io.MultiWriter(file, hasher, counter), res.Body)
	closeErr := file.Close()
	if copyErr != nil {
		return fmt.Errorf("download interrupted: %w", copyErr)
	}
	if closeErr != nil {
		return fmt.Errorf("failed to write file: %w", closeErr)
	}

	if task.SHA256 != "" {
		got := hex.EncodeToString(hasher.Sum(nil))
		if !strings.EqualFold(got, task.SHA256) {
			return fmt.Errorf("checksum mismatch: expected %s\u2026, got %s\u2026", short(task.SHA256), short(got))
		}
	}
	return nil
}

// promote extracts (if needed), sets exec permission, and atomically replaces the target
func promote(task Task, staging string) error {
	source := staging
	if task.Gzip {
		decompressed := staging[:len(staging)-3] // strip .gz
		if err := gunzipFile(staging, decompressed); err != nil {
			return err
		}
		defer os.Remove(decompressed)
		source = decompressed
	}
	if task.Zip {
		extracted := staging[:len(staging)-4] // strip .zip
		if err := unzipSingleFile(staging, task.ZipInner, extracted); err != nil {
			return err
		}
		defer os.Remove(extracted)
		source = extracted
	}

	if err := os.Chmod(source, 0o755); err != nil {
		return fmt.Errorf("failed to set executable permission: %w", err)
	}
	// Remove the old file first: Windows cannot overwrite a running exe, but it can rename it
	_ = os.Remove(task.Target)
	if err := os.Rename(source, task.Target); err != nil {
		return fmt.Errorf("failed to replace %s: %w", task.Target, err)
	}
	return nil
}

// gunzipFile extracts a single-member gzip; ffmpeg-static ships raw gzip streams (not tar.gz)
func gunzipFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("failed to open temp file: %w", err)
	}
	defer in.Close()

	zr, err := gzip.NewReader(in)
	if err != nil {
		return errors.New("extraction failed: " + err.Error())
	}
	defer zr.Close()

	out, err := os.Create(dst)
	if err != nil {
		return fmt.Errorf("failed to create file: %w", err)
	}
	if _, err := io.Copy(out, zr); err != nil {
		out.Close()
		os.Remove(dst)
		return fmt.Errorf("extraction failed: %w", err)
	}
	if err := out.Close(); err != nil {
		os.Remove(dst)
		return fmt.Errorf("failed to write file: %w", err)
	}
	return nil
}

// unzipSingleFile extracts a single file from a zip archive.
//
// An empty inner takes the first file in the archive; otherwise match by path exactly.
// Only a single file may be extracted (no directory traversal: the cleaned path must stay
// inside the archive) — our use case is literally "get one executable out".
func unzipSingleFile(src, inner, dst string) error {
	zr, err := zip.OpenReader(src)
	if err != nil {
		return fmt.Errorf("extraction failed: %w", err)
	}
	defer zr.Close()

	var target *zip.File
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		if inner == "" {
			target = f
			break
		}
		if filepath.Clean(f.Name) == filepath.Clean(inner) {
			target = f
			break
		}
	}
	if target == nil {
		return fmt.Errorf("extraction failed: no %q in the zip archive", inner)
	}

	rc, err := target.Open()
	if err != nil {
		return fmt.Errorf("extraction failed: %w", err)
	}
	defer rc.Close()

	out, err := os.Create(dst)
	if err != nil {
		return fmt.Errorf("failed to create file: %w", err)
	}
	if _, err := io.Copy(out, rc); err != nil {
		out.Close()
		os.Remove(dst)
		return fmt.Errorf("extraction failed: %w", err)
	}
	if err := out.Close(); err != nil {
		os.Remove(dst)
		return fmt.Errorf("failed to write file: %w", err)
	}
	return nil
}

// Finalize does post-install platform handling: on macOS clear quarantine attrs and ad-hoc sign.
// Executables downloaded from the network carry com.apple.quarantine; on Apple Silicon they get "killed: 9" outright.
func Finalize(path string, opts Options, emit Emitter) {
	if runtime.GOOS != "darwin" || opts.SkipSign {
		return
	}
	if emit == nil {
		emit = func(Event) {}
	}
	if err := runQuiet("xattr", "-c", path); err != nil {
		emit(Event{Event: "warn", Message: "failed to clear quarantine attribute: " + err.Error()})
	}
	if err := runQuiet("codesign", "--force", "--sign", "-", path); err != nil {
		emit(Event{Event: "warn", Message: "ad-hoc signing failed: " + err.Error()})
	}
}

func runQuiet(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	hideWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		if msg := strings.TrimSpace(string(out)); msg != "" {
			return errors.New(msg)
		}
		return err
	}
	return nil
}

// progressCounter reports progress in 1% steps to avoid spamming
type progressCounter struct {
	tool    string
	total   int64
	written int64
	lastPct int64
	emit    Emitter
}

func newProgressCounter(tool string, total int64, emit Emitter) *progressCounter {
	return &progressCounter{tool: tool, total: total, emit: emit}
}

func (w *progressCounter) Write(p []byte) (int, error) {
	w.written += int64(len(p))
	if w.emit != nil {
		pct := int64(-1)
		if w.total > 0 {
			pct = w.written * 100 / w.total
		}
		if pct != w.lastPct {
			w.lastPct = pct
			w.emit(Event{Event: "progress", Tool: w.tool, Downloaded: w.written, Total: w.total})
		}
	}
	return len(p), nil
}

func short(hash string) string {
	if len(hash) <= 12 {
		return hash
	}
	return hash[:12]
}

// reQueryString matches the query string of a URL
var reQueryString = regexp.MustCompile(`\?[^\s"]*`)

// sanitizeURL strips the query string from a URL.
//
// GitHub download URLs carry a very long signed JWT; showing it to users is both
// unreadable and fills the whole UI, so keep only host/path.
func sanitizeURL(msg string) string {
	return reQueryString.ReplaceAllString(msg, "")
}

// networkHint appends an actionable suggestion for common network failures
func networkHint(err error) string {
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "proxyconnect"), strings.Contains(msg, "proxy"):
		return "\n\nHint: the proxy is unreachable. Check the proxy address under Settings → Proxy and retry."
	case strings.Contains(msg, "tls"), strings.Contains(msg, "timeout"), strings.Contains(msg, "deadline"):
		return "\n\nHint: connection timed out. If your network needs a proxy, configure it under Settings → Proxy and retry."
	}
	return ""
}
