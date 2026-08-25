package main

import (
	"bufio"
	"bytes"
	"os"
	"regexp"
	"strings"
	"time"
)

// autoDetectPatterns is the pool of common log4j / logback layout patterns used
// when the user has not configured an explicit format. The list is derived from
// the Log4j 2.x PatternLayout reference (https://logging.apache.org/log4j/2.x/manual/pattern-layout.html)
// and widely used real-world conventions. Format specifiers inside {} are
// ignored by the compiler, so structurally identical patterns collapse to the
// same regex and are scored only once.
var autoDetectPatterns = []string{
	// ---- date, level, [thread], logger, dash, msg ----
	`%d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] %-5level %logger{36} - %msg%n`,
	`%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level [%thread] %logger - %msg%n`,
	`%d{yyyy-MM-dd HH:mm:ss,SSS} %-5level [%thread] %logger - %msg%n`,
	`%d{yyyy-MM-dd HH:mm:ss,SSS} %-5p [%t] %c - %m%n`,
	`%d{ISO8601} %-5level [%thread] %logger - %msg%n`,
	`%d{ISO8601} %-5p [%t] %c - %m%n`,
	`%d{yyyy-MM-dd HH:mm:ss} %-5level [%thread] %logger - %msg%n`,
	`%d{yyyy-MM-dd HH:mm:ss} [%thread] %-5level %logger - %msg%n`,
	`%d %-5level [%thread] %logger - %msg%n`,
	`%d [%thread] %-5level %logger - %msg%n`,
	`%d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] %-5level %logger{39} %msg%n`,
	`%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level [%thread] %logger %msg%n`,

	// ---- no thread ----
	`%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level %logger{36} - %msg%n`,
	`%d{yyyy-MM-dd HH:mm:ss,SSS} %-5p %c - %m%n`,
	`%d{ISO8601} %-5p %c - %m%n`,
	`%d %-5level %logger - %msg%n`,
	`%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level %logger %msg%n`,
	`%d{yyyy-MM-dd HH:mm:ss} %-5p %c %m%n`,

	// ---- date inside brackets ----
	`[%d{yyyy-MM-dd HH:mm:ss,SSS}] [%t] %-5p %c - %m%n`,
	`[%d{yyyy-MM-dd HH:mm:ss,SSS}] %-5p %c - %m%n`,
	`[%d{yyyy-MM-dd HH:mm:ss.SSS}] [%thread] %-5level %logger - %msg%n`,
	`[%d{yyyy-MM-dd HH:mm:ss}] %-5level %logger - %msg%n`,

	// ---- level first, no date ----
	`%-5p [%t] %c - %m%n`,
	`%-5level [%thread] %logger - %msg%n`,
	`%-5p %c - %m%n`,
	`[%-5level] %c{1.} %msg%n`,

	// ---- logger right after date, colon or dash separator (Pinpoint-style) ----
	`%d{MM-dd HH:mm:ss.SSS} %-5level %logger : %msg%n`,
	`%d{MM-dd HH:mm:ss.SSS} %-5level %logger - %msg%n`,
	`%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level %logger : %msg%n`,
	`%d{yyyy-MM-dd HH:mm:ss} %level %logger : %msg%n`,

	// ---- with caller location info ----
	`%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level [%thread] %C.%M(%F:%L) - %msg%n`,
	`%d{yyyy-MM-dd HH:mm:ss,SSS} %-5p [%t] %C.%M(%F:%L) - %m%n`,
	`%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level [%thread] %C.%M:%L - %msg%n`,
	`%d{ISO8601} %-5p [%t] %C.%M - %m%n`,

	// ---- log4j 1.x defaults / relative time / NDC ----
	`%r [%t] %p %c %x - %m%n`,
	`%d{ABSOLUTE} %-5p [%t] %c - %m%n`,
	`%r %p %c - %m%n`,

	// ---- MDC / thread id prefixes ----
	`%d{yyyy-MM-dd HH:mm:ss.SSS} [%X{requestId}] [%thread] %-5level %logger - %msg%n`,
	`%d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] [%X{requestId}] %-5level %logger - %msg%n`,

	// ---- Spring Boot default console pattern (pid + --- + thread) ----
	`%d{yyyy-MM-dd HH:mm:ss.SSS}  %5level %pid --- [%thread] %logger : %msg%n`,
	`%d{yyyy-MM-dd HH:mm:ss.SSS} %5level %pid --- [%thread] %logger : %msg%n`,
	`%d{yyyy-MM-dd HH:mm:ss.SSS} %5level [%thread] %logger : %msg%n`,

	// ---- generic space-separated ----
	`%d{yyyy-MM-dd HH:mm:ss} %p %t %c - %m%n`,
	`%d{yyyy-MM-dd HH:mm:ss.SSS} %level %thread %logger - %msg%n`,
}

// compiledAutoPatterns holds the deduplicated, compiled candidate patterns.
var compiledAutoPatterns = func() []*recordPattern {
	seen := make(map[string]bool)
	var out []*recordPattern
	for _, ps := range autoDetectPatterns {
		rp := compileRecordPattern(ps)
		if rp == nil {
			continue
		}
		if src := rp.re.String(); seen[src] {
			continue
		} else {
			seen[src] = true
		}
		out = append(out, rp)
	}
	return out
}()

const (
	detectMaxLines = 150     // sample up to this many candidate header lines per window
	detectMinLines = 3       // need at least this many before trusting a result
	detectUseScore = 0.8     // minimum score to adopt an auto-detected format
	multiWindowMin = 8 * 1024 // sample extra regions only for larger files
)

// detectFormats reads sample windows from a few regions of the file and tries
// to find log4j/logback layout patterns that explain the columns. It returns
// the dominant pattern first, optionally followed by a second, structurally
// different pattern that fits the lines the first one misses (mixed-format
// files). An empty result means nothing fits well enough and the caller should
// fall back to the lightweight heuristic parser.
func detectFormats(f *os.File, size int64, year int) []*recordPattern {
	windows := sampleWindows(f, size)
	if len(windows) == 0 {
		return nil
	}

	// Primary: the best-scoring pattern over all windows.
	var best *recordPattern
	bestScore := 0.0
	for _, lines := range windows {
		if len(lines) < detectMinLines {
			continue
		}
		for _, rp := range compiledAutoPatterns {
			if s := scorePattern(rp, lines, year); s > bestScore {
				bestScore, best = s, rp
			}
		}
	}
	if best == nil || bestScore < detectUseScore {
		return nil
	}

	// Secondary: the best pattern over the residual lines (the lines the
	// primary pattern does not match), so a second format in the same file
	// still gets proper columns.
	var alt *recordPattern
	altScore := 0.0
	for _, lines := range windows {
		var residual [][]byte
		for _, ln := range lines {
			if best.re.FindSubmatch(ln) == nil {
				residual = append(residual, ln)
			}
		}
		if len(residual) < 2 {
			continue
		}
		for _, rp := range compiledAutoPatterns {
			if rp == best || rp.re.String() == best.re.String() {
				continue
			}
			if s := scorePattern(rp, residual, year); s > altScore {
				altScore, alt = s, rp
			}
		}
	}

	out := []*recordPattern{best}
	if alt != nil && altScore >= detectUseScore {
		out = append(out, alt)
	}
	return out
}

// sampleWindows reads candidate header lines from up to three regions of the
// file (start, one third, two thirds). Small files use only the start.
func sampleWindows(f *os.File, size int64) [][][]byte {
	var windows [][][]byte
	positions := []int64{0}
	if size > multiWindowMin {
		positions = append(positions, size/3, 2*size/3)
	}
	for _, pos := range positions {
		if pos > 0 {
			a, err := lineAlignStart(f, pos, size)
			if err != nil {
				continue
			}
			pos = a
		}
		lines := readSampleLinesAt(f, pos)
		if len(lines) >= detectMinLines {
			windows = append(windows, lines)
		}
	}
	return windows
}

// readSampleLinesAt returns up to detectMaxLines non-empty lines that look like
// the start of a log record (obvious continuation/stack-trace lines are
// skipped). Reading stops at EOF.
func readSampleLinesAt(f *os.File, pos int64) [][]byte {
	if _, err := f.Seek(pos, 0); err != nil {
		return nil
	}
	r := bufio.NewReaderSize(f, 64*1024)
	var out [][]byte
	for len(out) < detectMaxLines {
		line, err := r.ReadBytes('\n')
		if len(line) == 0 {
			break
		}
		ln := bytes.TrimRight(line, "\r\n")
		if len(ln) == 0 {
			continue
		}
		if isContinuationLine(ln) {
			continue
		}
		out = append(out, ln)
		if err != nil {
			break
		}
	}
	return out
}

var continuationRe = regexp.MustCompile(`^(?:\s|Caused by:|Suppressed:|\.\.\.\s*\d+\s*more\b)`)

// isContinuationLine reports whether a line is almost certainly a continuation
// of the previous record (stack trace frame, wrapped message) rather than a new
// record header.
func isContinuationLine(b []byte) bool {
	return continuationRe.Match(b)
}

// scorePattern measures how well a compiled pattern explains the sample lines.
// Matching rate dominates, with small bonuses for structurally sound fields and
// larger penalties when a field swallows message content (thread/logger/date
// misalignment).
func scorePattern(rp *recordPattern, lines [][]byte, year int) float64 {
	matched := 0
	var dateBad, dateN, levelBad, levelN, thrBad, thrN, lgBad, lgN, msgBad, msgN int
	for _, ln := range lines {
		m := rp.re.FindSubmatch(ln)
		if m == nil {
			continue
		}
		matched++
		if i, ok := rp.index["date"]; ok {
			dateN++
			if _, ok2 := parseDateFast(string(m[i]), year); !ok2 {
				dateBad++
			}
		}
		if i, ok := rp.index["level"]; ok {
			levelN++
			if !validLevel(m[i]) {
				levelBad++
			}
		}
		if i, ok := rp.index["thread"]; ok {
			thrN++
			if !validThread(bytes.TrimSpace(m[i])) {
				thrBad++
			}
		}
		if i, ok := rp.index["logger"]; ok {
			lgN++
			if hasBracket(bytes.TrimSpace(m[i])) {
				lgBad++
			}
		}
		if i, ok := rp.index["msg"]; ok {
			msgN++
			v := bytes.TrimSpace(m[i])
			if len(v) > 0 && (v[0] == '-' || v[0] == ':') {
				msgBad++
			}
		}
	}
	if matched == 0 {
		return 0
	}

	matchRate := float64(matched) / float64(len(lines))
	if matchRate < 0.5 {
		return matchRate * 0.3
	}
	score := matchRate

	if dateN > 0 {
		if float64(dateN-dateBad)/float64(dateN) >= 0.9 {
			score += 0.06
		} else {
			score -= 0.2
		}
	}
	if levelN > 0 {
		if float64(levelN-levelBad)/float64(levelN) >= 0.6 {
			score += 0.06
		} else {
			score -= 0.2
		}
	}
	if thrN > 0 {
		if thrBad == 0 {
			score += 0.06
		} else {
			score -= 0.35
		}
	}
	if lgN > 0 {
		if lgBad == 0 {
			score += 0.05
		} else {
			score -= 0.15
		}
	}
	if msgN > 0 && float64(msgBad)/float64(msgN) >= 0.5 {
		score -= 0.3
	}

	nf := len(rp.fields)
	if nf > 5 {
		nf = 5
	}
	score += 0.015 * float64(nf)
	return score
}

var knownLevels = map[string]bool{
	"OFF": true, "FATAL": true, "ERROR": true, "WARN": true, "INFO": true,
	"DEBUG": true, "TRACE": true, "ALL": true,
	"SEVERE": true, "WARNING": true, "FINE": true, "FINER": true, "FINEST": true,
	"CONFIG": true, "NOTICE": true, "CRITICAL": true, "ALERT": true,
	"EMERGENCY": true, "EMERG": true, "PANIC": true, "SUCCESS": true,
	"FAILURE": true, "FAIL": true, "NONE": true,
	"TRC": true, "DBG": true, "INF": true, "WRN": true, "ERR": true, "FTL": true,
	"LOG": true,
}

// validLevel reports whether a captured level token looks like a log level
// rather than arbitrary message text.
func validLevel(b []byte) bool {
	if len(b) == 0 || len(b) > 8 {
		return false
	}
	for _, c := range b {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
			return false
		}
	}
	if knownLevels[strings.ToUpper(string(b))] {
		return true
	}
	// Unknown but plausible custom level: short and written in upper case
	// (e.g. the %level{length=1} compact forms W / I / E / D / T / F).
	if len(b) <= 5 {
		allUpper := true
		for _, c := range b {
			if c < 'A' || c > 'Z' {
				allUpper = false
				break
			}
		}
		return allUpper
	}
	return false
}

// validThread reports whether a captured thread token is plausible (a short
// name, not a long run of text that swallowed the rest of the line).
func validThread(b []byte) bool {
	if len(b) == 0 || len(b) > 200 {
		return false
	}
	if hasBracket(b) {
		return false
	}
	if bytes.IndexAny(b, " \t") >= 0 {
		return len(b) <= 16
	}
	return true
}

func hasBracket(b []byte) bool {
	return bytes.IndexAny(b, "[]") >= 0
}

func daysInMonth(mo, y int) int {
	switch mo {
	case 1, 3, 5, 7, 8, 10, 12:
		return 31
	case 4, 6, 9, 11:
		return 30
	case 2:
		if (y%4 == 0 && y%100 != 0) || y%400 == 0 {
			return 29
		}
		return 28
	}
	return 0
}

// parseDateFast parses the common log4j/logback date outputs into a unix
// timestamp without the cost of time.Parse. It accepts:
//
//	YYYY-MM-DD[ T]HH:mm[:ss[.fff]]   (DEFAULT / ISO8601 / custom)
//	MM-DD[ T]HH:mm[:ss[.fff]]        (Pinpoint style)
//	HH:mm[:ss[.fff]]                 (ABSOLUTE, time-only -> Jan 1 of year)
//
// A trailing UTC offset or 'Z' is stripped. Returns ok=false for anything else.
func parseDateFast(s string, year int) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	s = strings.Replace(s, "T", " ", 1)

	// strip a trailing UTC offset like Z, +07, -0700, +08:00
	if i := strings.LastIndexAny(s, "+-"); i > 0 && isOffsetTail(s[i+1:]) {
		s = s[:i]
	}
	if strings.HasSuffix(s, "Z") || strings.HasSuffix(s, "z") {
		s = s[:len(s)-1]
	}

	datePart, timePart, hasDate := "", s, false
	if idx := strings.IndexByte(s, ' '); idx >= 0 {
		datePart = s[:idx]
		timePart = s[idx+1:]
		hasDate = true
	}

	h, mi, ss := 0, 0, 0
	{
		segs := strings.Split(timePart, ":")
		if len(segs) < 2 || len(segs) > 3 {
			return 0, false
		}
		var ok bool
		if h, ok = atoiStr(segs[0]); !ok {
			return 0, false
		}
		if mi, ok = atoiStr(segs[1]); !ok {
			return 0, false
		}
		if len(segs) == 3 {
			if ss, ok = atoiStr(segs[2]); !ok {
				return 0, false
			}
		}
	}
	if h > 23 || mi > 59 || ss > 60 {
		return 0, false
	}

	mo, d := 1, 1
	if hasDate {
		segs := strings.Split(datePart, "-")
		switch len(segs) {
		case 3:
			y, ok1 := atoiStr(segs[0])
			m, ok2 := atoiStr(segs[1])
			dd, ok3 := atoiStr(segs[2])
			if !ok1 || !ok2 || !ok3 {
				return 0, false
			}
			year, mo, d = y, m, dd
		case 2:
			m, ok2 := atoiStr(segs[0])
			dd, ok3 := atoiStr(segs[1])
			if !ok2 || !ok3 {
				return 0, false
			}
			mo, d = m, dd
		default:
			return 0, false
		}
	}
	if mo < 1 || mo > 12 || d < 1 || d > daysInMonth(mo, year) {
		return 0, false
	}
	return time.Date(year, time.Month(mo), d, h, mi, ss, 0, time.Local).Unix(), true
}

// isOffsetTail reports whether the tail of a date string (after the last + or -)
// looks like a UTC offset: digits and optional colon only.
func isOffsetTail(t string) bool {
	if t == "" {
		return true
	}
	for i := 0; i < len(t); i++ {
		c := t[i]
		if (c < '0' || c > '9') && c != ':' {
			return false
		}
	}
	return true
}

// atoiStr parses the leading integer of s. It returns false when s has no
// digits (it stops at the first non-digit, so "22.902" parses as 22).
func atoiStr(s string) (int, bool) {
	if s == "" {
		return 0, false
	}
	n := 0
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			break
		}
		n = n*10 + int(c-'0')
	}
	return n, true
}