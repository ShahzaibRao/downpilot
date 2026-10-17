package runtime

import (
	"testing"
	"time"
)

func TestScanExpiredZeroMeansUnlimited(t *testing.T) {
	scanDeadline = time.Time{} // zero value
	if scanExpired(time.Now()) {
		t.Error("zero value should mean no deadline, otherwise the scan silently does nothing")
	}
	scanDeadline = time.Now().Add(-time.Second)
	if !scanExpired(time.Now()) {
		t.Error("an expired deadline should count as timed out")
	}
	scanDeadline = time.Now().Add(time.Hour)
	if scanExpired(time.Now()) {
		t.Error("a future deadline should not count as timed out")
	}
}

// setScanBudgetForTest only adjusts the dir budget, **while also setting a valid deadline**.
//
// Lesson learned from CI: writing `scanDirsLeft = N` directly without touching the deadline
// makes the case inherit the previous case's expired deadline, so the scan silently does nothing
// — passes alone, randomly fails in full runs or with -shuffle (classic state leak).
func setScanBudgetForTest(n int) {
	scanDirsLeft = n
	scanDeadline = time.Now().Add(scanTimeLimit)
}
