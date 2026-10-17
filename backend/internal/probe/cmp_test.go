package probe

import "testing"

func TestCompare(t *testing.T) {
	cases := []struct {
		a, b string
		want int
	}{
		{"2026.08.19", "2026.10.10.233141", -1},
		{"2026.10.10.233141", "2026.10.10.233141", 0},
		{"2026.10.11", "2026.10.10.233141", 1},
		{"2025.12.31", "2026.01.01", -1},
		{"6.0", "4", 1},
		{"", "2026.01.01", -1}, // empty version sorts as smallest; the "unknown is never judged" rule lives in IsOlder
	}
	for _, c := range cases {
		if got := CompareVersions(c.a, c.b); got != c.want {
			t.Errorf("CompareVersions(%q,%q)=%d want %d", c.a, c.b, got, c.want)
		}
	}
	if !IsOlder("2026.08.19", "2026.10.10.233141") {
		t.Error("2026.08.19 should be judged too old")
	}
	if IsOlder("2026.10.10.233141", "2026.10.10.233141") {
		t.Error("same version should not be judged too old")
	}
	// Unknown versions are never judged too old (so probe failures are not misreported as "too old")
	if IsOlder("", "2026.10.10") {
		t.Error("empty version should not be judged too old")
	}
	if IsOlder("2026.08.19", "") {
		t.Error("empty threshold should not judge anything too old")
	}
}
