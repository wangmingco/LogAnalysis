package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the application struct holding backend state.
type App struct {
	ctx     context.Context
	mu      sync.Mutex
	files   []*ParsedLog // currently parsed files
	lastRes *CombinedResult
}

// NewApp creates a new App instance.
func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// ---- file discovery ----

type FileInfo struct {
	Name string `json:"name"`
	Path string `json:"path"`
	Size int64  `json:"size"`
}

// ListLogFiles lists .log files in the given directory (recursively if recursive=true).
func (a *App) ListLogFiles(dir string, recursive bool) []FileInfo {
	out := make([]FileInfo, 0)
	_ = filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			if !recursive && path != dir {
				return filepath.SkipDir
			}
			return nil
		}
		ext := strings.ToLower(filepath.Ext(info.Name()))
		if ext == ".log" || ext == ".txt" || ext == ".out" {
			out = append(out, FileInfo{Name: info.Name(), Path: path, Size: info.Size()})
		}
		return nil
	})
	sort.Slice(out, func(i, j int) bool {
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out
}

// PickDirectory opens a folder dialog and returns the selected path.
func (a *App) PickDirectory() string {
	dir, err := runtime.OpenDirectoryDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "选择日志工作目录",
	})
	if err != nil || dir == "" {
		return ""
	}
	return dir
}

// PickFile opens a file dialog and returns the selected file path.
func (a *App) PickFile() string {
	file, err := runtime.OpenFileDialog(a.ctx, runtime.OpenDialogOptions{
		Title: "选择日志文件",
		Filters: []runtime.FileFilter{
			{DisplayName: "日志文件 (*.log;*.txt;*.out)", Pattern: "*.log;*.txt;*.out;*"},
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil || file == "" {
		return ""
	}
	return file
}

// GetDefaultYear returns a suggested year for parsing MM-DD timestamps.
func (a *App) GetDefaultYear() int {
	return time.Now().Year()
}

// GetWorkingDir returns the app's current working directory (where it was launched).
func (a *App) GetWorkingDir() string {
	wd, err := os.Getwd()
	if err != nil {
		return ""
	}
	return wd
}

// ---- loading ----

// LoadFiles parses the given file paths (each in parallel) into memory.
// Files that are already loaded are skipped so repeated loads of the same
// file never duplicate the data. Returns metadata for each successfully
// loaded (newly parsed) file.
func (a *App) LoadFiles(paths []string, year int, logFormat string) []FileInfo {
	loaded := make([]FileInfo, 0)
	var wg sync.WaitGroup
	var loadedMu sync.Mutex

	format := compileRecordPattern(strings.TrimSpace(logFormat))

	a.mu.Lock()
	existing := make(map[string]bool)
	for _, pl := range a.files {
		existing[pl.Path] = true
	}
	a.mu.Unlock()

	queued := make(map[string]bool)
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" || existing[p] || queued[p] {
			continue
		}
		queued[p] = true
		wg.Add(1)
		go func(p string) {
			defer wg.Done()
			pl, err := parseLogFile(p, year, format)
			if err != nil {
				return
			}
			a.mu.Lock()
			a.files = append(a.files, pl)
			a.mu.Unlock()
			loadedMu.Lock()
			loaded = append(loaded, FileInfo{Name: filepath.Base(p), Path: p, Size: pl.Size})
			loadedMu.Unlock()
		}(p)
	}
	wg.Wait()
	a.mu.Lock()
	a.lastRes = nil
	a.mu.Unlock()
	return loaded
}

// GetLoadedFiles returns info about currently loaded files.
func (a *App) GetLoadedFiles() []FileInfo {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]FileInfo, 0)
	for _, pl := range a.files {
		out = append(out, FileInfo{Name: filepath.Base(pl.Path), Path: pl.Path, Size: pl.Size})
	}
	return out
}

// GetDetectedFormats returns the log4j/logback patterns that were auto-detected
// for each loaded file that was parsed without an explicit user format. Empty
// when the user configured a format or nothing could be detected.
func (a *App) GetDetectedFormats() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	var out []string
	for _, pl := range a.files {
		if pl.AutoDetected {
			if pl.FormatStr != "" {
				out = append(out, pl.FormatStr)
			}
			if pl.AltFormatStr != "" {
				out = append(out, pl.AltFormatStr)
			}
		}
	}
	return out
}

// UnloadAll clears all loaded files and frees memory.
func (a *App) UnloadAll() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, pl := range a.files {
		pl.Close()
	}
	a.files = nil
	a.lastRes = nil
}

// TimeRange describes the min/max timestamps present across all loaded files.
type TimeRange struct {
	Min string `json:"min"` // "2006-01-02 15:04:05" or "" if none
	Max string `json:"max"`
}

// GetTimeRange returns the timestamp of the first and last timestamped record
// across all currently loaded files (in file order). Empty strings mean no
// timestamped records were found.
func (a *App) GetTimeRange() TimeRange {
	a.mu.Lock()
	files := make([]*ParsedLog, len(a.files))
	copy(files, a.files)
	a.mu.Unlock()

	var first, last *RecordRef
	for _, pl := range files {
		for _, r := range pl.Records {
			if !r.HasTime {
				continue
			}
			if first == nil {
				first = r
			}
			last = r
		}
	}
	if first == nil {
		return TimeRange{}
	}
	return TimeRange{
		Min: time.Unix(first.Unix, 0).Format("2006-01-02 15:04:05"),
		Max: time.Unix(last.Unix, 0).Format("2006-01-02 15:04:05"),
	}
}

// ---- combined filtering across loaded files ----

type CombinedIndex struct {
	File int `json:"file"`
	Rec  int `json:"rec"`
}

type CombinedResult struct {
	Total int             `json:"total"`
	Items []CombinedIndex `json:"items"`
}

type FilterStats struct {
	Total          int    `json:"total"`
	FilesLoaded    int    `json:"filesLoaded"`
	TotalBytes     int64  `json:"totalBytes"`
	PhysicalLines  int64  `json:"physicalLines"` // physical lines covered by matched records
	FoldedLines    int64  `json:"foldedLines"`   // continuation lines folded into logical records
	Message        string `json:"message"`
}

// Filter runs the filter across all loaded files and stores the combined result.
func (a *App) Filter(params FilterParams) FilterStats {
	a.mu.Lock()
	files := make([]*ParsedLog, len(a.files))
	copy(files, a.files)
	a.mu.Unlock()

	if len(files) == 0 {
		a.mu.Lock()
		a.lastRes = &CombinedResult{}
		a.mu.Unlock()
		return FilterStats{Message: "没有已加载的文件"}
	}

	var res CombinedResult
	var totalBytes, physicalLines, foldedLines int64
	for fi, pl := range files {
		totalBytes += pl.Size
		r := filterLog(pl, params, nil)
		spans := pl.lineSpans()
		for _, idx := range r.Indices {
			res.Items = append(res.Items, CombinedIndex{File: fi, Rec: idx})
			sp := spans[idx]
			physicalLines += sp
			foldedLines += sp - 1
		}
	}
	res.Total = len(res.Items)

	a.mu.Lock()
	a.lastRes = &res
	a.mu.Unlock()

	return FilterStats{
		Total:         res.Total,
		FilesLoaded:   len(files),
		TotalBytes:    totalBytes,
		PhysicalLines: physicalLines,
		FoldedLines:   foldedLines,
	}
}

// GetPage returns a page of log entries from the last filter result.
func (a *App) GetPage(offset, limit int) []LogEntry {
	a.mu.Lock()
	files := make([]*ParsedLog, len(a.files))
	copy(files, a.files)
	res := a.lastRes
	a.mu.Unlock()

	if res == nil || len(files) == 0 {
		return nil
	}
	if offset < 0 {
		offset = 0
	}
	if limit <= 0 {
		limit = 100
	}
	start := offset
	end := offset + limit
	if start > len(res.Items) {
		start = len(res.Items)
	}
	if end > len(res.Items) {
		end = len(res.Items)
	}
	out := make([]LogEntry, 0, end-start)
	for _, it := range res.Items[start:end] {
		if it.File >= len(files) || it.Rec >= len(files[it.File].Records) {
			continue
		}
		rec := files[it.File].Records[it.Rec]
		entry := LogEntry{
			LineNo:  rec.LineNo,
			Time:    rec.Time,
			Level:   rec.Level,
			Logger:  rec.Logger,
			Thread:  rec.Thread,
			Msg:     rec.Msg,
			Unix:    rec.Unix,
			HasTime: rec.HasTime,
			Text:    string(files[it.File].readRecord(rec)),
		}
		if len(files) > 1 {
			entry.FileName = filepath.Base(files[it.File].Path)
		}
		out = append(out, entry)
	}
	return out
}

// Greet kept for template compatibility.
func (a *App) Greet(name string) string {
	return fmt.Sprintf("Hello %s", name)
}
