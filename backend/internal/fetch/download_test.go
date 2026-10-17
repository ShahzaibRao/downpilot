package fetch

import (
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func gzipBytes(t *testing.T, payload []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(payload); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func zipBytes(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, payload := range files {
		w, err := zw.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(payload); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// zip archive: extract only the ZipInner-specified single file; the checksum covers the archive itself
func TestInstallZipExtractsSingleFile(t *testing.T) {
	payload := []byte("#!/bin/sh\necho deno\n")
	archive := zipBytes(t, map[string][]byte{
		"deno":         payload,
		"README.md":    []byte("not the binary"),
		"subdir/other": []byte("noise"),
	})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(archive)))
		w.Write(archive)
	}))
	defer srv.Close()

	target := filepath.Join(t.TempDir(), "deno")
	err := Install(context.Background(), []Task{{
		Tool: "deno", URL: srv.URL, SHA256: sha256Hex(archive),
		Zip: true, ZipInner: "deno", Target: target,
	}}, Options{Timeout: 30 * time.Second})
	if err != nil {
		t.Fatalf("install failed: %v", err)
	}

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("extracted content mismatch, got %q", got)
	}
}

// a zip missing the ZipInner-specified file must error, leaving no target file behind
func TestInstallZipRejectsMissingInner(t *testing.T) {
	archive := zipBytes(t, map[string][]byte{"deno": []byte("x")})

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(archive)))
		w.Write(archive)
	}))
	defer srv.Close()

	target := filepath.Join(t.TempDir(), "deno")
	err := Install(context.Background(), []Task{{
		Tool: "deno", URL: srv.URL, SHA256: sha256Hex(archive),
		Zip: true, ZipInner: "deno.exe", Target: target,
	}}, Options{Timeout: 30 * time.Second})
	if err == nil {
		t.Fatal("should error: no deno.exe in the zip")
	}
	if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
		t.Error("no target file should remain after failure")
	}
}

// the checksum covers the downloaded bytes (the archive for gzip); install after extraction
func TestInstallGzipVerifiesCompressedBytes(t *testing.T) {
	payload := []byte("#!/bin/sh\necho hello\n")
	archive := gzipBytes(t, payload)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(archive)))
		w.Write(archive)
	}))
	defer srv.Close()

	target := filepath.Join(t.TempDir(), "tool")
	err := Install(context.Background(), []Task{{
		Tool: "ffmpeg", URL: srv.URL, SHA256: sha256Hex(archive), Gzip: true, Target: target,
	}}, Options{Timeout: 30 * time.Second})
	if err != nil {
		t.Fatalf("install failed: %v", err)
	}

	got, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, payload) {
		t.Errorf("extracted content mismatch, got %q", got)
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(target)
		if info.Mode().Perm()&0o100 == 0 {
			t.Error("installed file should be executable")
		}
	}
}

// a checksum failure must abort the install and leave no executable behind
func TestInstallRejectsBadChecksum(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("malicious payload"))
	}))
	defer srv.Close()

	dir := t.TempDir()
	target := filepath.Join(dir, "tool")
	err := Install(context.Background(), []Task{{
		Tool: "yt-dlp", URL: srv.URL, SHA256: strings.Repeat("0", 64), Target: target,
	}}, Options{Timeout: 30 * time.Second, Retries: 1})
	if err == nil {
		t.Fatal("checksum failure should return an error")
	}
	if !strings.Contains(err.Error(), "checksum mismatch") {
		t.Errorf("error should mention checksum mismatch, got: %v", err)
	}
	if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
		t.Error("no target file should remain after checksum failure")
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		t.Errorf("dir should stay clean, but found %s", e.Name())
	}
}

// should retry automatically after the first request fails
func TestInstallRetriesThenSucceeds(t *testing.T) {
	payload := []byte("binary")
	attempts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts++
		if attempts == 1 {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.Write(payload)
	}))
	defer srv.Close()

	target := filepath.Join(t.TempDir(), "tool")
	err := Install(context.Background(), []Task{{
		Tool: "yt-dlp", URL: srv.URL, SHA256: sha256Hex(payload), Target: target,
	}}, Options{Timeout: 30 * time.Second, Retries: 3})
	if err != nil {
		t.Fatalf("should succeed after retry: %v", err)
	}
	if attempts < 2 {
		t.Errorf("should request at least twice, got %d", attempts)
	}
}

// progress events must track the archive size, not post-extraction bytes (or percentages exceed 100%)
func TestProgressNeverExceedsTotal(t *testing.T) {
	archive := gzipBytes(t, bytes.Repeat([]byte("x"), 512*1024))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(archive)))
		w.Write(archive)
	}))
	defer srv.Close()

	var events []Event
	err := Install(context.Background(), []Task{{
		Tool: "ffmpeg", URL: srv.URL, SHA256: sha256Hex(archive), Gzip: true,
		Target: filepath.Join(t.TempDir(), "tool"),
	}}, Options{Timeout: 30 * time.Second, Emit: func(e Event) { events = append(events, e) }})
	if err != nil {
		t.Fatal(err)
	}

	var sawProgress bool
	for _, e := range events {
		if e.Event != "progress" {
			continue
		}
		sawProgress = true
		if e.Total <= 0 {
			continue
		}
		if e.Downloaded > e.Total {
			t.Errorf("downloaded %d exceeds total %d", e.Downloaded, e.Total)
		}
	}
	if !sawProgress {
		t.Error("should report progress at least once")
	}
}

// replacing an existing file must succeed (overwriting a running exe fails on Windows — delete first)
func TestInstallOverwritesExisting(t *testing.T) {
	payload := []byte("new content")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write(payload)
	}))
	defer srv.Close()

	target := filepath.Join(t.TempDir(), "tool")
	if err := os.WriteFile(target, []byte("old content"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := Install(context.Background(), []Task{{
		Tool: "yt-dlp", URL: srv.URL, SHA256: sha256Hex(payload), Target: target,
	}}, Options{Timeout: 30 * time.Second}); err != nil {
		t.Fatalf("overwrite install failed: %v", err)
	}
	got, _ := os.ReadFile(target)
	if string(got) != string(payload) {
		t.Errorf("file not updated, content is %q", got)
	}
}

func TestInstallRejectsEmptyTaskList(t *testing.T) {
	if err := Install(context.Background(), nil, Options{}); err == nil {
		t.Error("empty task list should return an error")
	}
}

// GitHub download URLs carry a very long signed JWT: error messages must keep only host/path,
// or the UI gets blown up by a meaningless query string
func TestSanitizeURLStripsQuery(t *testing.T) {
	raw := `Get "https://release-assets.githubusercontent.com/x/y?sp=r&sig=AbCdEf123&jwt=eyJhbGciOiJIUzI1NiJ9.long.token": net/http: TLS handshake timeout`
	got := sanitizeURL(raw)
	if strings.Contains(got, "sig=") || strings.Contains(got, "jwt=") {
		t.Errorf("query string was not stripped: %q", got)
	}
	if !strings.Contains(got, "release-assets.githubusercontent.com/x/y") {
		t.Errorf("host and path should be kept: %q", got)
	}
	if !strings.Contains(got, "TLS handshake timeout") {
		t.Errorf("original error cause should be kept: %q", got)
	}
}

// proxy vs timeout need different handling — the hints must distinguish them
func TestNetworkHint(t *testing.T) {
	cases := []struct {
		msg  string
		want string
	}{
		{"proxyconnect tcp: dial tcp 127.0.0.1:1: connect: connection refused", "proxy"},
		{"net/http: TLS handshake timeout", "timed out"},
		{"some other failure", ""},
	}
	for _, c := range cases {
		got := networkHint(errors.New(c.msg))
		if c.want == "" {
			if got != "" {
				t.Errorf("%q should not produce a hint, got %q", c.msg, got)
			}
			continue
		}
		if !strings.Contains(got, c.want) {
			t.Errorf("hint for %q should contain %q, got %q", c.msg, c.want, got)
		}
	}
}
