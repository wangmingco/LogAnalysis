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

// TestLoadText verifies clipboard/text-sourced logs are parsed, deduplicated by
// content, and that their backing temp files are cleaned up on unload.
func TestLoadText(t *testing.T) {
	logText := "08-16 21:30:22.903 INFO  LoggerA : first alpha message\n" +
		"08-16 21:30:25.100 ERROR LoggerB : second beta problem\n"

	app := NewApp()
	app.startup(context.Background())
	defer app.UnloadAll()

	first := app.LoadText("剪切板", logText, 2026, "")
	if len(first) != 1 {
		t.Fatalf("first LoadText: expected 1, got %d", len(first))
	}
	got := app.GetLoadedFiles()
	if len(got) != 1 {
		t.Fatalf("GetLoadedFiles after LoadText: expected 1, got %d", len(got))
	}
	if got[0].Name != "剪切板 1" {
		t.Fatalf("expected name 剪切板 1, got %q", got[0].Name)
	}

	// Identical text -> skipped.
	if second := app.LoadText("剪切板", logText, 2026, ""); len(second) != 0 {
		t.Fatalf("identical LoadText: expected 0 new, got %d", len(second))
	}

	// Different text -> loaded under the next sequence number.
	more := "08-16 21:31:00.000 WARN  LoggerC : third gamma warn\n"
	if third := app.LoadText("文本输入", more, 2026, ""); len(third) != 1 {
		t.Fatalf("second LoadText: expected 1 new, got %d", len(third))
	}
	if n := len(app.GetLoadedFiles()); n != 2 {
		t.Fatalf("GetLoadedFiles after two LoadText: expected 2, got %d", n)
	}

	// Filtering sees both text-sourced logs.
	stats := app.Filter(FilterParams{Year: 2026})
	if stats.Total != 3 {
		t.Fatalf("expected 3 records from text loads, got %d", stats.Total)
	}

	// Temp files created during this test must be removed after unload. Compare
	// against the set that existed beforehand so unrelated leftovers from a real
	// app session don't trip the check.
	globTemp := func() []string {
		m, _ := filepath.Glob(filepath.Join(os.TempDir(), "loganalysis-*.log"))
		return m
	}
	before := globTemp()
	app.UnloadAll()
	after := globTemp()
	for _, f := range after {
		if !listHas(before, f) {
			t.Fatalf("LoadText temp file leaked: %s", f)
		}
	}
}

func listHas(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
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