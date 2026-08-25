package main

import (
	"bytes"
	"runtime"
	"strings"
	"sync"
	"time"
)

// FilterParams describes a filtering request.
type FilterParams struct {
	Year      int      `json:"year"`
	StartTime string   `json:"startTime"` // "MM-DD HH:mm:ss" or ""
	EndTime   string   `json:"endTime"`   // "MM-DD HH:mm:ss" or ""
	Keywords  []string `json:"keywords"`  // all must match (AND), case-insensitive
	Level     string   `json:"level"`     // optional single level, "" = any
}

type LogEntry struct {
	LineNo   int64  `json:"lineNo"`
	Time     string `json:"time"`
	Level    string `json:"level"`
	Logger   string `json:"logger"`
	Thread   string `json:"thread"`
	Msg      string `json:"msg"`
	Unix     int64  `json:"unix"`
	HasTime  bool   `json:"hasTime"`
	Text     string `json:"text"`
	FileName string `json:"fileName"`
}

type FilterResult struct {
	Total   int   `json:"total"`
	Indices []int `json:"indices"`
}

func parseDT(year int, s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	// Accept "MM-DD HH:mm:ss" or "MM-DD HH:mm"
	layouts := []string{"01-02 15:04:05", "01-02 15:04", "15:04:05", "15:04", "2006-01-02 15:04:05", "2006-01-02 15:04"}
	for _, l := range layouts {
		if t, err := time.ParseInLocation(l, s, time.Local); err == nil {
			if strings.HasPrefix(l, "01-02") {
				t = time.Date(year, t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), 0, time.Local)
			}
			return t.Unix(), true
		}
	}
	return 0, false
}

// filterLog matches records against params and returns matched indices.
// It runs in parallel across the available cores. Progress is reported via
// the supplied callback (bytes done / total bytes).
func filterLog(pl *ParsedLog, params FilterParams, progress func(done, total int64)) *FilterResult {
	var startUnix, endUnix int64
	hasStart, hasEnd := false, false
	if params.StartTime != "" {
		if u, ok := parseDT(params.Year, params.StartTime); ok {
			startUnix, hasStart = u, true
		}
	}
	if params.EndTime != "" {
		if u, ok := parseDT(params.Year, params.EndTime); ok {
			endUnix, hasEnd = u, true
		}
	}
	level := strings.ToUpper(strings.TrimSpace(params.Level))
	var kws [][]byte
	for _, k := range params.Keywords {
		k = strings.TrimSpace(k)
		if k != "" {
			kws = append(kws, bytes.ToLower([]byte(k)))
		}
	}

	records := pl.Records
	if len(records) == 0 {
		return &FilterResult{}
	}
	needText := len(kws) > 0

	nworkers := runtime.NumCPU()
	if nworkers > 8 {
		nworkers = 8
	}
	if nworkers < 1 {
		nworkers = 1
	}
	if nworkers > len(records) {
		nworkers = len(records)
	}

	chunkSize := (len(records) + nworkers - 1) / nworkers
	results := make([][]int, nworkers)
	var wg sync.WaitGroup

	for w := 0; w < nworkers; w++ {
		lo := w * chunkSize
		hi := lo + chunkSize
		if hi > len(records) {
			hi = len(records)
		}
		if lo >= hi {
			continue
		}
		wg.Add(1)
		go func(w, lo, hi int) {
			defer wg.Done()
			var matched []int
			// Read the whole contiguous byte range for this worker in one call.
			startOff := records[lo].Offset
			endOff := records[hi-1].Offset + records[hi-1].Length
			var buf []byte
			if needText {
				buf = make([]byte, endOff-startOff)
				_, _ = pl.fh.ReadAt(buf, startOff)
				buf = bytes.ToLower(buf)
			}
			for i := lo; i < hi; i++ {
				rec := records[i]
				if hasStart && rec.Unix < startUnix {
					continue
				}
				if hasEnd && rec.Unix > endUnix {
					continue
				}
				if level != "" && rec.Level != level {
					continue
				}
				if needText {
					text := buf[rec.Offset-startOff : rec.Offset-startOff+rec.Length]
					ok := true
					for _, kw := range kws {
						if !bytes.Contains(text, kw) {
							ok = false
							break
						}
					}
					if !ok {
						continue
					}
				}
				matched = append(matched, i)
			}
			results[w] = matched
		}(w, lo, hi)
	}
	wg.Wait()

	var all []int
	for w := range results {
		all = append(all, results[w]...)
	}
	res := &FilterResult{Indices: all, Total: len(all)}
	_ = progress
	return res
}

// getPage materializes a page of log entries from matched indices.
func getPage(pl *ParsedLog, indices []int, offset, limit int) []LogEntry {
	if offset < 0 {
		offset = 0
	}
	if limit <= 0 {
		limit = 100
	}
	start := offset
	end := offset + limit
	if start > len(indices) {
		start = len(indices)
	}
	if end > len(indices) {
		end = len(indices)
	}
	out := make([]LogEntry, 0, end-start)
	for _, idx := range indices[start:end] {
		rec := pl.Records[idx]
		out = append(out, LogEntry{
			LineNo:  rec.LineNo,
			Time:    rec.Time,
			Level:   rec.Level,
			Logger:  rec.Logger,
			HasTime: rec.HasTime,
			Text:    string(pl.readRecord(rec)),
		})
	}
	return out
}
