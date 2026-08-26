package main

import (
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App is the application struct holding backend state.
type App struct {
	ctx      context.Context
	mu       sync.Mutex
	files    []*ParsedLog // currently parsed files
	lastRes  *CombinedResult
	textSeq  int // counter for naming clipboard/text-sourced logs
}

// NewApp creates a new App instance.
func NewApp() *App {
	return &App{}
}

func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

// shutdown releases loaded data on app exit, including removing the temp files
// that back clipboard/text-sourced logs.
func (a *App) shutdown(ctx context.Context) {
	a.UnloadAll()
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

// ---- config persistence ----

// Config describes the persisted UI settings (filter + format). It is stored in
// the OS temp dir so the app can restore the last session on the next launch.
type Config struct {
	Year       int    `json:"year"`
	LogFormat  string `json:"logFormat"`
	WorkingDir string `json:"workingDir"`
}

// configPath returns the config file location in the OS temp directory.
// os.TempDir() honours the platform convention: Windows %TEMP%, and the
// TMPDIR/TEMP/TMP env vars on Linux/macOS (usually /tmp).
func configPath() string {
	return filepath.Join(os.TempDir(), "loganalysis-config.json")
}

// LoadConfig reads the persisted config from the OS temp dir. It returns a
// zero-valued Config when the file is missing or unreadable, so callers can
// fall back to defaults.
func (a *App) LoadConfig() Config {
	var cfg Config
	data, err := os.ReadFile(configPath())
	if err != nil {
		return cfg
	}
	_ = json.Unmarshal(data, &cfg)
	return cfg
}

// SaveConfig writes the given config to the OS temp dir.
func (a *App) SaveConfig(cfg Config) {
	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return
	}
	_ = os.WriteFile(configPath(), data, 0o600)
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

// LoadText parses log text pasted from the clipboard or entered manually. The
// text is written to a temporary file and processed by the same pipeline as
// file loads. It is registered under a synthetic path (e.g. "剪切板 1",
// "文本输入 2") so it behaves like any other loaded source. Loading the exact
// same text twice is skipped. Returns metadata for each newly loaded source.
func (a *App) LoadText(label string, text string, year int, logFormat string) []FileInfo {
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	key := textKey(text)

	a.mu.Lock()
	for _, pl := range a.files {
		if pl.TextKey == key {
			a.mu.Unlock()
			return nil // identical text already loaded
		}
	}
	a.textSeq++
	seq := a.textSeq
	a.mu.Unlock()

	tmp, err := writeTextTemp(text)
	if err != nil {
		return nil
	}
	format := compileRecordPattern(strings.TrimSpace(logFormat))
	pl, err := parseLogFile(tmp, year, format)
	if err != nil {
		_ = os.Remove(tmp)
		return nil
	}
	name := fmt.Sprintf("%s %d", label, seq)
	pl.Path = name
	pl.tempPath = tmp
	pl.TextKey = key

	a.mu.Lock()
	for _, ex := range a.files {
		if ex.TextKey == key {
			a.mu.Unlock()
			_ = os.Remove(tmp)
			return nil // lost the race with a concurrent identical load
		}
	}
	a.files = append(a.files, pl)
	a.lastRes = nil
	a.mu.Unlock()
	return []FileInfo{{Name: name, Path: name, Size: pl.Size}}
}

// writeTextTemp writes text to a fresh temp file (kept in the OS temp dir) and
// returns its path. The caller is responsible for removing the file.
func writeTextTemp(text string) (string, error) {
	f, err := os.CreateTemp("", "loganalysis-*.log")
	if err != nil {
		return "", err
	}
	tmp := f.Name()
	if _, err := f.WriteString(text); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return "", err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return tmp, nil
}

// textKey returns a content hash used to deduplicate clipboard/text loads.
func textKey(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
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

// Export writes the current filter results to a CSV file chosen via a save
// dialog (default filename "YYYYMMDDHHMMSS.log"). The exported columns are
// exactly the ones the result list currently shows: only the given visible
// column ids (line/file/time/level/thread/logger/msg) are written, and only
// the records matching the current filter. format indicates the list is in
// structured mode (msg = parsed message) vs plain mode (msg = raw record
// text). Returns the written file's info, or an empty FileInfo when the user
// cancels the dialog.
func (a *App) Export(format bool, cols []string) FileInfo {
	a.mu.Lock()
	files := make([]*ParsedLog, len(a.files))
	copy(files, a.files)
	res := a.lastRes
	a.mu.Unlock()

	if res == nil || len(files) == 0 {
		return FileInfo{}
	}

	path, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		Title:           "导出匹配结果",
		DefaultFilename: time.Now().Format("20060102150405") + ".log",
		Filters: []runtime.FileFilter{
			{DisplayName: "日志文件 (*.log)", Pattern: "*.log"},
			{DisplayName: "所有文件 (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil || path == "" {
		return FileInfo{} // cancelled
	}

	f, err := os.Create(path)
	if err != nil {
		return FileInfo{}
	}
	defer f.Close()
	_, _ = f.WriteString("\xEF\xBB\xBF") // UTF-8 BOM so Excel reads Chinese correctly
	w := csv.NewWriter(f)

	labels := map[string]string{
		"line": "行号", "file": "文件", "time": "时间", "level": "级别",
		"thread": "线程", "logger": "Logger", "msg": "消息",
	}
	if !format {
		labels["msg"] = "内容"
	}
	header := make([]string, len(cols))
	for i, c := range cols {
		header[i] = labels[c]
	}
	_ = w.Write(header)

	for _, it := range res.Items {
		if it.File >= len(files) || it.Rec >= len(files[it.File].Records) {
			continue
		}
		pl := files[it.File]
		rec := pl.Records[it.Rec]
		row := make([]string, len(cols))
		for i, c := range cols {
			switch c {
			case "line":
				row[i] = strconv.FormatInt(rec.LineNo, 10)
			case "file":
				row[i] = filepath.Base(pl.Path)
			case "time":
				row[i] = rec.Time
			case "level":
				row[i] = rec.Level
			case "thread":
				row[i] = rec.Thread
			case "logger":
				row[i] = rec.Logger
			case "msg":
				if format {
					row[i] = rec.Msg
				} else {
					row[i] = string(pl.readRecord(rec))
				}
			}
		}
		_ = w.Write(row)
	}
	w.Flush()
	st, _ := f.Stat()
	return FileInfo{Name: filepath.Base(path), Path: path, Size: st.Size()}
}

// Greet kept for template compatibility.
func (a *App) Greet(name string) string {
	return fmt.Sprintf("Hello %s", name)
}
