package runtime

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// must also work when scanDir is called directly (without findOne)
func TestScanWorksWithoutExplicitDeadline(t *testing.T) {
	scanDeadline = time.Time{}
	resetScanBudget()
	root := t.TempDir()
	sub := filepath.Join(root, "bin")
	os.MkdirAll(sub, 0o755)
	os.WriteFile(filepath.Join(sub, BinaryName(KindFFmpeg)), []byte("x"), 0o755)
	if got := scanDir(root, BinaryName(KindFFmpeg), 0); got == "" {
		t.Error("should scan normally without a deadline set (this is how CI failed)")
	}
}
