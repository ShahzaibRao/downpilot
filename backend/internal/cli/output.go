// Package cli outputs NDJSON: stdout carries only structured results, stderr carries log text.
package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
)

var (
	mu sync.Mutex
)

// Emit serializes any structure as one JSON line on stdout
func Emit(v any) {
	mu.Lock()
	defer mu.Unlock()
	line, err := json.Marshal(v)
	if err != nil {
		return
	}
	fmt.Fprintln(os.Stdout, string(line))
}

// Log writes one diagnostic log line to stderr (the Electron side collects it into the log file)
func Log(msg string) {
	fmt.Fprintln(os.Stderr, "[deps] "+msg)
}

// Fail prints an error event and exits the process
func Fail(msg string) {
	Emit(map[string]string{"event": "error", "message": msg})
	Log("error: " + msg)
	os.Exit(1)
}
