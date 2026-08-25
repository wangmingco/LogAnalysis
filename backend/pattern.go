package main

import (
	"regexp"
	"strings"
)

// Regex fragments for the individual log4j/logback conversion specifiers.
// Every fragment must either be empty-free of whitespace anchoring or, if it
// spans text with a known shape (date), must match that shape loosely so that
// padded/truncated real-world values still line up.
const (
	// dateRe matches the common log4j/logback date outputs:
	//   YYYY-MM-DD[ T]HH:mm[:ss[.fff]][Z|±HH[:MM]]   (ISO8601 / DEFAULT / custom)
	//   MM-DD[ T]HH:mm[:ss[.fff]]        (Pinpoint-style)
	//   HH:mm[:ss[.fff]]                 (ABSOLUTE / time-only)
	dateRe = `(?<date>(?:\d{4}-\d{1,2}-\d{1,2}|\d{1,2}-\d{1,2})[ T]\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?|\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)`

	levelRe  = `(?<level>[^\s]+)`
	threadRe = `(?<thread>[^\]\r\n]+)`
	loggerRe = `(?<logger>[^\s]+)`
	msgRe    = `(?<msg>.+)`
	classRe  = `(?<class>[^\s]+)`
	methodRe = `(?<method>[^\s()]+)`
	fileRe   = `(?<file>[^\s:()]+)`
	numRe    = `\d+`
	tokenRe  = `[^\s]+`
	uuidRe   = `[0-9a-fA-F-]{8,}`
)

// conversionRegex maps a (case-insensitive unless noted) log4j conversion
// specifier name to the regex fragment that matches its output. The second
// return value reports whether the token is recognized at all (true). Pure
// layout tokens such as %n are recognized but produce no captured field.
func conversionRegex(name string) (string, bool) {
	switch name {
	case "n":
		return `\s*`, true
	case "N":
		return numRe, true
	case "d":
		return dateRe, true
	case "p":
		return levelRe, true
	case "c":
		return loggerRe, true
	case "m":
		return msgRe, true
	case "t":
		return threadRe, true
	case "T":
		return numRe, true
	case "C":
		return classRe, true
	case "M":
		return methodRe, true
	case "L":
		return numRe, true
	case "F":
		return fileRe, true
	case "l":
		return tokenRe, true
	case "r":
		return numRe, true
	case "x":
		return tokenRe, true
	case "X":
		return tokenRe, true
	case "K":
		return tokenRe, true
	case "u":
		return uuidRe, true
	}
	switch strings.ToLower(name) {
	case "date":
		return dateRe, true
	case "level", "le", "levelshort":
		return levelRe, true
	case "thread", "tn", "threadshort", "threadname":
		return threadRe, true
	case "threadid", "tid":
		return numRe, true
	case "logger", "lo", "loggername":
		return loggerRe, true
	case "msg", "message":
		return msgRe, true
	case "class":
		return classRe, true
	case "method":
		return methodRe, true
	case "line":
		return numRe, true
	case "file":
		return fileRe, true
	case "location":
		return tokenRe, true
	case "pid", "processid":
		return numRe, true
	case "relative":
		return numRe, true
	case "ndc":
		return tokenRe, true
	case "mdc", "map":
		return tokenRe, true
	case "marker":
		return tokenRe, true
	case "sn", "sequencenumber":
		return numRe, true
	case "nano":
		return numRe, true
	case "uuid":
		return uuidRe, true
	case "threadpriority", "tp":
		return numRe, true
	case "fqcn":
		return tokenRe, true
	case "newline":
		return `\s*`, true
	}
	return "", false
}

// logbackPattern compiles a logback/log4j-style layout pattern into a RE2
// regular expression with named capture groups for the supported fields:
//
//	%d / %date        timestamp (%d{format} is ignored for matching)
//	%p / %level       level (supports optional width like %-5level)
//	%t / %thread      thread name
//	%c / %logger      logger name (optional {length} ignored)
//	%m / %msg         message
//	%n                newline
//	%C / %class, %M / %method, %L / %line, %F / %file, %l / %location
//	%T / %tid / %threadId, %pid / %processId, %r / %relative, %N / %nano,
//	%sn / %sequenceNumber, %u / %uuid, %tp / %threadPriority
//	%x / %NDC, %X{key} / %mdc{key}, %K{key} / %map{key}, %marker
//	%%                literal '%'
//
// Any other text is treated as a literal. Runs of literal whitespace are
// matched loosely (one or more spaces) so padded fields still line up.
//
// The returned regexp is nil if the pattern contains no field tokens.
func logbackPattern(pattern string) *regexp.Regexp {
	var sb strings.Builder
	sb.WriteString(`(?s)^`)

	hasField := false
	i := 0
	for i < len(pattern) {
		c := pattern[i]
		if c != '%' {
			// collect a run of literal text up to the next '%'
			j := i
			for j < len(pattern) && pattern[j] != '%' {
				j++
			}
			lit := pattern[i:j]
			sb.WriteString(litRegex(lit))
			i = j
			continue
		}
		// '%%' -> a single literal '%'
		if i+1 < len(pattern) && pattern[i+1] == '%' {
			sb.WriteString(`%`)
			i += 2
			continue
		}
		// '%' field token
		j := i + 1
		// optional flags/width like "-5" or "5"
		for j < len(pattern) && (pattern[j] == '-' || (pattern[j] >= '0' && pattern[j] <= '9')) {
			j++
		}
		// read the field name (letters), optionally followed by {..}
		k := j
		for k < len(pattern) && ((pattern[k] >= 'a' && pattern[k] <= 'z') || (pattern[k] >= 'A' && pattern[k] <= 'Z')) {
			k++
		}
		name := pattern[j:k]
		// skip a trailing {format} specifier (nested braces allowed)
		skip := k
		if skip < len(pattern) && pattern[skip] == '{' {
			depth := 1
			skip++
			for skip < len(pattern) && depth > 0 {
				if pattern[skip] == '{' {
					depth++
				} else if pattern[skip] == '}' {
					depth--
				}
				skip++
			}
		}

		if rgx, known := conversionRegex(name); known {
			sb.WriteString(rgx)
			// every recognized token except the pure-layout ones (%n) is a field
			if name != "n" && !strings.EqualFold(name, "newline") {
				hasField = true
			}
		} else {
			// unknown token -> treat literally
			sb.WriteString(regexp.QuoteMeta("%" + name))
		}
		i = skip
	}

	if !hasField {
		return nil
	}
	sb.WriteString(`$`)
	return regexp.MustCompile(sb.String())
}

// litRegex turns literal text into regex, collapsing runs of whitespace to
// \s+ so variable-width padding in real logs still matches.
func litRegex(lit string) string {
	var sb strings.Builder
	run := 0
	flush := func() {
		if run > 0 {
			sb.WriteString(`\s+`)
			run = 0
		}
	}
	for i := 0; i < len(lit); i++ {
		c := lit[i]
		if c == ' ' || c == '\t' || c == '\r' || c == '\n' {
			run++
			continue
		}
		flush()
		sb.WriteString(regexp.QuoteMeta(string(c)))
	}
	flush()
	return sb.String()
}

// recordPattern holds a compiled logback/log4j pattern plus extracted field order.
type recordPattern struct {
	re     *regexp.Regexp
	src    string         // the original pattern string
	fields []string       // ordered list of present field names
	index  map[string]int // capture index per field name
}

func compileRecordPattern(pattern string) *recordPattern {
	re := logbackPattern(pattern)
	if re == nil {
		return nil
	}
	order := []string{"date", "level", "thread", "logger", "msg"}
	var present []string
	idx := make(map[string]int)
	for _, f := range order {
		if i := re.SubexpIndex(f); i >= 0 {
			present = append(present, f)
			idx[f] = i
		}
	}
	return &recordPattern{re: re, src: pattern, fields: present, index: idx}
}