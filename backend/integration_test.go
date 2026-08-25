package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func TestAppIntegration(t *testing.T) {
	dir := t.TempDir()
	path1 := filepath.Join(dir, "a.log")
	path2 := filepath.Join(dir, "b.log")
	os.WriteFile(path1, []byte(
		"08-16 21:30:22.903 INFO  LoggerA : first alpha message\n"+
			"08-16 21:30:25.100 ERROR LoggerB : second beta problem\n"+
			"continuation line of error\n"+
			"08-16 21:31:00.000 WARN  LoggerC : third alpha warn\n"), 0644)
	os.WriteFile(path2, []byte(
		"08-16 21:30:23.000 INFO  LoggerD : another alpha line\n"+
			"08-16 21:31:10.500 DEBUG LoggerE : no match here\n"), 0644)

	app := NewApp()
	app.startup(context.Background())
	defer app.UnloadAll()

	loaded := app.LoadFiles([]string{path1, path2}, 2026, "")
	if len(loaded) != 2 {
		t.Fatalf("expected 2 loaded, got %d", len(loaded))
	}

	// Filter with keyword "alpha" across both files
	stats := app.Filter(FilterParams{Year: 2026, Keywords: []string{"alpha"}})
	fmt.Println("alpha matches:", stats.Total)
	if stats.Total != 3 {
		t.Fatalf("expected 3 alpha matches, got %d", stats.Total)
	}

	// Multi-keyword AND: "alpha" + "problem" should match the continuation line record
	stats2 := app.Filter(FilterParams{Year: 2026, Keywords: []string{"beta", "problem"}})
	fmt.Println("beta+problem matches:", stats2.Total)
	if stats2.Total != 1 {
		t.Fatalf("expected 1 beta+problem match, got %d", stats2.Total)
	}
	// Verify multi-line continuation: the ERROR record includes its continuation
	page := app.GetPage(0, 10)
	for _, e := range page {
		fmt.Printf("  line=%d file=%s lvl=%s time=%s | %q\n", e.LineNo, e.FileName, e.Level, e.Time, e.Text)
		if e.Logger == "LoggerB" {
			if !contains(e.Text, "continuation line of error") {
				t.Fatalf("multi-line record not grouped: %q", e.Text)
			}
		}
	}

	// Time range filter
	stats3 := app.Filter(FilterParams{Year: 2026, StartTime: "08-16 21:31:00", EndTime: "08-16 21:31:30"})
	fmt.Println("time-range matches:", stats3.Total)
	if stats3.Total != 2 {
		t.Fatalf("expected 2 time-range matches, got %d", stats3.Total)
	}

	// Level filter
	stats4 := app.Filter(FilterParams{Year: 2026, Level: "ERROR"})
	fmt.Println("ERROR matches:", stats4.Total)
	if stats4.Total != 1 {
		t.Fatalf("expected 1 ERROR match, got %d", stats4.Total)
	}

	app.UnloadAll()
}

// TestLoadDedup verifies that loading the same file twice does not duplicate
// the underlying data (fixes result stacking when re-selecting a file).
func TestLoadDedup(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.log")
	os.WriteFile(path, []byte(
		"08-16 21:30:22.903 INFO  LoggerA : first alpha message\n"+
			"08-16 21:30:25.100 ERROR LoggerB : second beta problem\n"), 0644)

	app := NewApp()
	app.startup(context.Background())
	defer app.UnloadAll()

	first := app.LoadFiles([]string{path}, 2026, "")
	if len(first) != 1 {
		t.Fatalf("first load: expected 1, got %d", len(first))
	}

	// Load the same file again -> should be skipped.
	second := app.LoadFiles([]string{path}, 2026, "")
	if len(second) != 0 {
		t.Fatalf("second load: expected 0 new files, got %d", len(second))
	}

	got := app.GetLoadedFiles()
	if len(got) != 1 {
		t.Fatalf("GetLoadedFiles: expected 1, got %d", len(got))
	}

	// Filter must not double-count records.
	stats := app.Filter(FilterParams{Year: 2026})
	fmt.Println("all matches after dedup:", stats.Total)
	if stats.Total != 2 {
		t.Fatalf("expected 2 total records, got %d (dedup failed)", stats.Total)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}