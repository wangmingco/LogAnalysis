package main

import (
	"bufio"
	"bytes"
	"os"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

var timeRe = regexp.MustCompile(`^(?:(\d{4})-)?(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})([.,]\d+)?`)

// RecordRef describes a logical log record (a timestamped line plus any
// continuation lines that follow it). Records are contiguous in the file:
// record[i+1].Offset == record[i].Offset + record[i].Length.
type RecordRef struct {
	Offset  int64  `json:"offset"`
	Length  int64  `json:"length"`
	LineNo  int64  `json:"lineNo"`
	HasTime bool   `json:"hasTime"`
	Time    string `json:"time"`
	Level   string `json:"level"`
	Logger  string `json:"logger"`
	Thread  string `json:"thread"`
	Msg     string `json:"msg"`
	Unix    int64  `json:"unix"`
}

// ParsedLog is the in-memory result of scanning a single log file.
type ParsedLog struct {
	Path         string       `json:"path"`
	Size         int64        `json:"size"`
	TotalLines   int64        `json:"totalLines"`
	Records      []*RecordRef `json:"-"`
	fh           *os.File
	Year         int
	Format       *recordPattern // primary compiled pattern actually used, nil if none
	AltFormat    *recordPattern // secondary pattern for mixed-format files, may be nil
	FormatStr    string         // the pattern string that produced Format
	AltFormatStr string         // the pattern string that produced AltFormat
	AutoDetected bool           // true when formats were auto-detected (no user format)
}

// lineSpans returns, for every logical record, the number of physical file
// lines it spans (1 = a single-line record). Continuation lines that were
// folded into a record make its span > 1.
func (p *ParsedLog) lineSpans() []int64 {
	n := len(p.Records)
	spans := make([]int64, n)
	for i := 0; i < n; i++ {
		if i+1 < n {
			spans[i] = p.Records[i+1].LineNo - p.Records[i].LineNo
		} else {
			spans[i] = p.TotalLines - p.Records[i].LineNo + 1
		}
	}
	return spans
}

func (p *ParsedLog) Close() {
	if p.fh != nil {
		_ = p.fh.Close()
		p.fh = nil
	}
}

// lineAlignStart returns the byte offset of the start of the first line that
// begins at or after 'from'. 'from' must be > 0 and < size. The returned value
// is the position just after a '\n' (or the given position if it already is a
// line start). If no newline is found it returns 'from'.
func lineAlignStart(f *os.File, from int64, size int64) (int64, error) {
	buf := make([]byte, 64*1024)
	pos := from
	for pos < size {
		n, err := f.ReadAt(buf, pos)
		if n == 0 {
			break
		}
		idx := bytes.IndexByte(buf[:n], '\n')
		if idx >= 0 {
			return pos + int64(idx) + 1, nil
		}
		if err != nil {
			break
		}
		pos += int64(n)
	}
	return from, nil
}

type chunkRes struct {
	refs     []*RecordRef
	lineCnt  int64
	startLno int64
}

func parseLogFile(path string, year int, format *recordPattern) (*ParsedLog, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}
	size := st.Size()
	pl := &ParsedLog{Path: path, Size: size, fh: f, Year: year}

	// When the caller did not supply a format, try to detect one (or two, for
// mixed-format files) from sample lines using the log4j/logback pattern pool.
// If nothing fits well enough, parsing falls back to the lightweight heuristic
// parser.
	if format != nil {
		pl.Format = format
		pl.FormatStr = format.src
	} else if det := detectFormats(f, size, year); len(det) > 0 {
		pl.Format = det[0]
		pl.FormatStr = det[0].src
		pl.AutoDetected = true
		if len(det) > 1 {
			pl.AltFormat = det[1]
			pl.AltFormatStr = det[1].src
		}
	}
	// Use the effective patterns (user-provided or auto-detected) for chunks.
	format = pl.Format

	nworkers := runtime.NumCPU()
	if nworkers > 8 {
		nworkers = 8
	}
	if nworkers < 1 {
		nworkers = 1
	}

	// Compute line-aligned chunk boundaries.
	chunkSize := size / int64(nworkers)
	if chunkSize < 64*1024 {
		chunkSize = 64 * 1024
	}
	if chunkSize > size {
		chunkSize = size
	}
	var bounds []int64 // chunk start offsets (line-aligned)
	b := int64(0)
	for b < size {
		bounds = append(bounds, b)
		if b == 0 {
			// first chunk starts at 0
			end := chunkSize
			if end >= size {
				break
			}
			ab, aerr := lineAlignStart(f, end, size)
			if aerr == nil {
				b = ab
			} else {
				b = size
			}
		} else {
			end := b + chunkSize
			if end >= size {
				break
			}
			ab, aerr := lineAlignStart(f, end, size)
			if aerr == nil {
				b = ab
			} else {
				b = size
			}
		}
	}
	// ensure final boundary is size
	if len(bounds) == 0 || bounds[len(bounds)-1] != size {
		bounds = append(bounds, size)
	}

	results := make([]chunkRes, len(bounds)-1)
	var wg sync.WaitGroup
	for i := 0; i < len(bounds)-1; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			// Each worker gets its own handle: seeking a shared *os.File from
			// multiple goroutines is a data race.
			fh, oerr := os.Open(path)
			if oerr != nil {
				results[i] = chunkRes{}
				return
			}
			defer fh.Close()
			results[i] = parseChunk(fh, bounds[i], bounds[i+1], year, format, pl.AltFormat)
		}(i)
	}
	wg.Wait()

	// Compute starting line numbers per chunk via prefix sum of line counts.
	var acc int64
	for i := range results {
		results[i].startLno = acc
		acc += results[i].lineCnt
		for _, r := range results[i].refs {
			r.LineNo += results[i].startLno
		}
	}

	var all []*RecordRef
	for i := range results {
		all = append(all, results[i].refs...)
	}
	sort.SliceStable(all, func(i, j int) bool {
		return all[i].Offset < all[j].Offset
	})
	pl.Records = groupRecords(all)
	pl.TotalLines = acc
	return pl, nil
}

// groupRecords merges a flat list of line refs (sorted by offset) into logical
// records. A line without a timestamp is treated as a continuation of the
// previous record; its byte span is folded into that record's Length so the
// final records remain contiguous in the file.
func groupRecords(lines []*RecordRef) []*RecordRef {
	if len(lines) == 0 {
		return nil
	}
	var out []*RecordRef
	cur := lines[0]
	for _, ln := range lines[1:] {
		if ln.HasTime {
			out = append(out, cur)
			cur = ln
		} else {
			cur.Length = (ln.Offset + ln.Length) - cur.Offset
		}
	}
	out = append(out, cur)
	return out
}

func parseChunk(f *os.File, start, end int64, year int, format, alt *recordPattern) chunkRes {
	var refs []*RecordRef
	var lineCnt int64
	r := bufio.NewReaderSize(f, 256*1024)
	if _, err := f.Seek(start, 0); err != nil {
		return chunkRes{}
	}
	offset := start
	for {
		line, err := r.ReadBytes('\n')
		if len(line) == 0 {
			break
		}
		lineStart := offset
		offset += int64(len(line))
		if lineStart >= end {
			// This line belongs to the next chunk.
			break
		}
		lineCnt++
		ref := parseLine(line, year, lineCnt, lineStart, format, alt)
		refs = append(refs, ref)
		_ = err
	}
	return chunkRes{refs: refs, lineCnt: lineCnt}
}

func parseLine(raw []byte, year int, lineNo int64, offset int64, format, alt *recordPattern) *RecordRef {
	ref := &RecordRef{Offset: offset, Length: int64(len(raw)), LineNo: lineNo}
	line := bytes.TrimRight(raw, "\r\n")
	if len(line) == 0 {
		return ref
	}
	if format != nil {
		if parseWithFormat(ref, line, year, format) {
			return ref
		}
		if alt != nil && parseWithFormat(ref, line, year, alt) {
			return ref
		}
		// The line does not match any detected pattern. If it still begins
		// with a plausible timestamp it is a record header from another format
		// (e.g. a mixed-format file) — parse it heuristically so it becomes its
		// own record instead of a continuation of the previous one.
	}
	parseLineBasic(ref, line, year)
	return ref
}

// parseLineBasic is the lightweight heuristic parser used when no (matching)
// pattern is available. It extracts a leading timestamp plus a level/logger
// guess and, if possible, the message.
func parseLineBasic(ref *RecordRef, line []byte, year int) {
	m := timeRe.FindSubmatch(line)
	if m == nil {
		return
	}
	ref.HasTime = true
	ref.Time = string(m[0])

	y := year
	if len(m[1]) > 0 {
		y = atoi(m[1])
	}
	mm := atoi(m[2])
	dd := atoi(m[3])
	hh := atoi(m[4])
	mi := atoi(m[5])
	ss := atoi(m[6])
	ref.Unix = time.Date(y, time.Month(mm), dd, hh, mi, ss, 0, time.Local).Unix()

	rest := line[len(m[0]):]
	rest = bytes.TrimLeft(rest, " ")
	sp := bytes.IndexAny(rest, " \t")
	var levelTok []byte
	if sp < 0 {
		levelTok = rest
	} else {
		levelTok = rest[:sp]
		rest = bytes.TrimLeft(rest[sp:], " \t")
	}
	ref.Level = strings.ToUpper(string(levelTok))
	if i := bytes.IndexByte(rest, ':'); i >= 0 {
		ref.Logger = strings.TrimSpace(string(rest[:i]))
		ref.Msg = strings.TrimSpace(string(rest[i+1:]))
	} else if j := bytes.IndexAny(rest, " \t"); j >= 0 {
		ref.Logger = string(rest[:j])
		ref.Msg = strings.TrimSpace(string(rest[j:]))
	} else {
		ref.Logger = string(rest)
	}
}

// parseWithFormat parses a single line against a compiled log4j/logback pattern
// and fills the structured fields. It returns false if the line does not match
// the pattern (in which case the caller decides how to treat the line).
func parseWithFormat(ref *RecordRef, line []byte, year int, format *recordPattern) bool {
	m := format.re.FindSubmatch(line)
	if m == nil {
		return false
	}
	ref.HasTime = true
	if i, ok := format.index["date"]; ok {
		ref.Time = string(m[i])
		ref.Unix = parsePatternUnix(ref.Time, year)
	}
	if i, ok := format.index["level"]; ok {
		ref.Level = strings.ToUpper(string(m[i]))
	}
	if i, ok := format.index["thread"]; ok {
		ref.Thread = strings.TrimSpace(string(m[i]))
	}
	if i, ok := format.index["logger"]; ok {
		ref.Logger = strings.TrimSpace(string(m[i]))
	}
	if i, ok := format.index["msg"]; ok {
		ref.Msg = strings.TrimSpace(string(m[i]))
	}
	return true
}

// parsePatternUnix parses a date string captured from a log4j %date field into
// a unix timestamp. Common formats are parsed with the fast parser; exotic
// layouts (e.g. "%d{DATE}": "02 Nov 2012 14:34:02,781") fall back to time.Parse.
func parsePatternUnix(s string, year int) int64 {
	if u, ok := parseDateFast(s, year); ok {
		return u
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	if i := strings.LastIndexAny(s, ",."); i >= 0 {
		s = s[:i]
	}
	layouts := []string{"2006-01-02 15:04:05", "2006-01-02 15:04", "01-02 15:04:05", "01-02 15:04", "02 Jan 2006 15:04:05"}
	for _, l := range layouts {
		if t, err := time.ParseInLocation(l, s, time.Local); err == nil {
			if strings.HasPrefix(l, "01-02") {
				t = time.Date(year, t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), 0, time.Local)
			}
			return t.Unix()
		}
	}
	return 0
}

func atoi(b []byte) int {
	n := 0
	for _, c := range b {
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// readRecord returns the full raw text of a record (header + continuation lines).
func (p *ParsedLog) readRecord(rec *RecordRef) []byte {
	buf := make([]byte, rec.Length)
	_, _ = p.fh.ReadAt(buf, rec.Offset)
	return buf
}
