package main

import (
	"fmt"
	"os"
	"testing"
)

func writeLog(path, content string) {
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		panic(err)
	}
}

// TestDetectLogbackDefault exercises the classic logback default format:
//
//	2026-08-16 21:30:41,396 INFO  [main] com.xxl.X - hello world
func TestDetectLogbackDefault(t *testing.T) {
	dir := t.TempDir()
	path := dir + "\\a.log"
	writeLog(path, ""+
		"2026-08-16 21:30:41,396 INFO  [main] com.xxl.X - hello world\n"+
		"2026-08-16 21:30:42,100 ERROR [http-1] com.xxl.Y - boom failed\n"+
		"   at com.xxl.Y.doSomething(X.java:10)\n"+
		"2026-08-16 21:30:43,000 WARN  [main] com.xxl.Z - note thing\n")

	pl, err := parseLogFile(path, 2026, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer pl.Close()
	if pl.Format == nil || !pl.AutoDetected {
		t.Fatal("expected an auto-detected format")
	}
	if len(pl.Records) != 3 {
		t.Fatalf("expected 3 records, got %d", len(pl.Records))
	}
	r0 := pl.Records[0]
	if r0.Time != "2026-08-16 21:30:41,396" {
		t.Errorf("time: %q", r0.Time)
	}
	if r0.Level != "INFO" {
		t.Errorf("level: %q", r0.Level)
	}
	if r0.Thread != "main" {
		t.Errorf("thread: %q", r0.Thread)
	}
	if r0.Logger != "com.xxl.X" {
		t.Errorf("logger: %q", r0.Logger)
	}
	if r0.Msg != "hello world" {
		t.Errorf("msg: %q", r0.Msg)
	}
	// continuation grouped
	r1 := pl.Records[1]
	if !containsStr(string(pl.readRecord(r1)), "at com.xxl.Y.doSomething") {
		t.Errorf("stack trace not grouped: %q", pl.readRecord(r1))
	}
}

// TestDetectNoThread exercises a date/level/logger/msg layout without a thread.
func TestDetectNoThread(t *testing.T) {
	dir := t.TempDir()
	path := dir + "\\b.log"
	writeLog(path, ""+
		"2026-08-16 21:30:41,396 INFO  com.xxl.X hello world\n"+
		"2026-08-16 21:30:42,100 ERROR com.xxl.Y failed to connect\n"+
		"2026-08-16 21:30:43,000 WARN  com.xxl.Z slow request\n")

	pl, err := parseLogFile(path, 2026, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer pl.Close()
	if pl.Format == nil || !pl.AutoDetected {
		t.Fatal("expected an auto-detected format")
	}
	r0 := pl.Records[0]
	if r0.Thread != "" {
		t.Errorf("thread should be empty, got %q", r0.Thread)
	}
	if r0.Logger != "com.xxl.X" {
		t.Errorf("logger: %q", r0.Logger)
	}
	if r0.Msg != "hello world" {
		t.Errorf("msg: %q", r0.Msg)
	}
}

// TestDetectPinpoint exercises the real-world Pinpoint style layout:
//
//	08-16 21:30:22.902 INFO  PinpointBootStrap : pinpoint agentArgs:null
func TestDetectPinpoint(t *testing.T) {
	dir := t.TempDir()
	path := dir + "\\c.log"
	writeLog(path, ""+
		"08-16 21:30:22.902 INFO  PinpointBootStrap : pinpoint agentArgs:null\n"+
		"08-16 21:30:22.907 INFO  ClassAgentPathFinder : agentPath:/pinpoint-agent/x.jar\n"+
		"08-16 21:30:22.909 WARN  AgentDirBaseClassPathResolver : unresolved path\n"+
		"08-16 21:30:22.910 ERROR BootDir : cannot find bootstrap jar\n")

	pl, err := parseLogFile(path, 2026, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer pl.Close()
	if pl.Format == nil || !pl.AutoDetected {
		t.Fatal("expected an auto-detected format")
	}
	r0 := pl.Records[0]
	if r0.Time != "08-16 21:30:22.902" {
		t.Errorf("time: %q", r0.Time)
	}
	if r0.Level != "INFO" {
		t.Errorf("level: %q", r0.Level)
	}
	if r0.Logger != "PinpointBootStrap" {
		t.Errorf("logger: %q", r0.Logger)
	}
	if r0.Msg != "pinpoint agentArgs:null" {
		t.Errorf("msg: %q", r0.Msg)
	}
}

// TestDetectRejectsMsgInColumns makes sure the detector does NOT pick a pattern
// that swallows the message into the thread/logger column. Here a simple layout
// without a thread column must be chosen even though a greedy thread pattern
// also matches every line.
func TestDetectRejectsMsgInColumns(t *testing.T) {
	dir := t.TempDir()
	path := dir + "\\d.log"
	writeLog(path, ""+
		"2026-08-16 21:30:41,396 INFO  com.xxl.X - user signed in from 10.0.0.1\n"+
		"2026-08-16 21:30:42,100 ERROR com.xxl.Y - failed to connect to database server\n"+
		"2026-08-16 21:30:43,000 WARN  com.xxl.Z - connection pool nearly exhausted\n"+
		"2026-08-16 21:30:44,500 INFO  com.xxl.X - health check ok\n"+
		"2026-08-16 21:30:45,700 ERROR com.xxl.Y - timeout waiting for upstream api gateway\n")

	pl, err := parseLogFile(path, 2026, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer pl.Close()
	if pl.Format == nil || !pl.AutoDetected {
		t.Fatal("expected an auto-detected format")
	}
	for _, r := range pl.Records {
		if len(r.Thread) > 0 && len(r.Thread) > 16 {
			t.Errorf("thread swallowed message: %q", r.Thread)
		}
		if r.Msg == "" {
			t.Errorf("msg empty for line %d", r.LineNo)
		}
	}
	r0 := pl.Records[0]
	if r0.Msg != "user signed in from 10.0.0.1" {
		t.Errorf("msg: %q", r0.Msg)
	}
}

// TestDetectFallbackNoPattern: a file whose lines do not fit any log4j pattern
// must simply fall back to the heuristic parser (Format stays nil).
func TestDetectFallbackNoPattern(t *testing.T) {
	dir := t.TempDir()
	path := dir + "\\e.log"
	writeLog(path, ""+
		"some plain text line without any structure\n"+
		"another plain line, just text\n"+
		"and a third one to reach the sample minimum\n"+
		"fourth line, still nothing structured\n"+
		"fifth line, done\n"+
		"sixth line\n")

	pl, err := parseLogFile(path, 2026, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer pl.Close()
	if pl.Format != nil {
		t.Fatalf("expected no format, got %q", pl.FormatStr)
	}
}

// TestDetectISO8601 exercises an ISO-8601 timestamp with 'T' and an offset.
func TestDetectISO8601(t *testing.T) {
	dir := t.TempDir()
	path := dir + "\\f.log"
	writeLog(path, ""+
		"2012-11-02T14:34:02,781 INFO  [main] com.xxl.X - iso format\n"+
		"2012-11-02T14:34:03,100 ERROR [http-1] com.xxl.Y - boom\n"+
		"2012-11-02T14:34:04,000 WARN  [main] com.xxl.Z - note\n")

	pl, err := parseLogFile(path, 2012, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer pl.Close()
	if pl.Format == nil || !pl.AutoDetected {
		t.Fatal("expected an auto-detected format")
	}
	r0 := pl.Records[0]
	if r0.Thread != "main" || r0.Logger != "com.xxl.X" || r0.Msg != "iso format" {
		t.Errorf("r0: thr=%q log=%q msg=%q", r0.Thread, r0.Logger, r0.Msg)
	}
	if r0.Unix == 0 {
		t.Errorf("unix not parsed: %d", r0.Unix)
	}
}

// TestDetectISOTimezone exercises an ISO-8601 timestamp with a trailing Z.
func TestDetectISOTimezone(t *testing.T) {
	dir := t.TempDir()
	path := dir + "\\g.log"
	writeLog(path, ""+
		"2012-11-02T14:34:02,781Z INFO  [main] com.xxl.X - zulu format\n"+
		"2012-11-02T14:34:03,100Z ERROR [http-1] com.xxl.Y - boom\n"+
		"2012-11-02T14:34:04,000Z WARN  [main] com.xxl.Z - note\n")

	pl, err := parseLogFile(path, 2012, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer pl.Close()
	if pl.Format == nil || !pl.AutoDetected {
		t.Fatal("expected an auto-detected format")
	}
	r0 := pl.Records[0]
	if r0.Thread != "main" || r0.Logger != "com.xxl.X" || r0.Msg != "zulu format" {
		t.Errorf("r0: thr=%q log=%q msg=%q", r0.Thread, r0.Logger, r0.Msg)
	}
	if r0.Unix == 0 {
		t.Errorf("unix not parsed: %d", r0.Unix)
	}
}

// TestDetectAbsolute exercises a time-only (%d{ABSOLUTE}) layout.
func TestDetectAbsolute(t *testing.T) {
	dir := t.TempDir()
	path := dir + "\\h.log"
	writeLog(path, ""+
		"14:34:02,781 INFO  [main] com.xxl.X - time only\n"+
		"14:34:03,100 ERROR [http-1] com.xxl.Y - boom\n"+
		"14:34:04,000 WARN  [main] com.xxl.Z - note\n")

	pl, err := parseLogFile(path, 2026, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer pl.Close()
	if pl.Format == nil || !pl.AutoDetected {
		t.Fatal("expected an auto-detected format")
	}
	r0 := pl.Records[0]
	if r0.Thread != "main" || r0.Logger != "com.xxl.X" || r0.Msg != "time only" {
		t.Errorf("r0: thr=%q log=%q msg=%q", r0.Thread, r0.Logger, r0.Msg)
	}
	if r0.Unix == 0 {
		t.Errorf("unix not parsed for time-only: %d", r0.Unix)
	}
}

func TestParseDateFast(t *testing.T) {
	cases := []struct {
		s    string
		year int
		ok   bool
	}{
		{"2026-08-16 21:30:41", 2026, true},
		{"2026-08-16 21:30:41,396", 2026, true},
		{"2026-08-16 21:30:22.902", 2026, true},
		{"2012-11-02T14:34:02,781", 2012, true},
		{"08-16 21:30:22.902", 2026, true},
		{"14:34:02,781", 2026, true},
		{"2012-11-02T14:34:02,781-07", 2012, true},
		{"2012-11-02T14:34:02,781-07:00", 2012, true},
		{"2026-08-16 21:30", 2026, true},
		{"2026-02-30 21:30:00", 2026, false}, // Feb 30 does not exist
		{"2026-13-01 21:30:00", 2026, false}, // month 13
		{"hello world", 2026, false},
		{"", 2026, false},
	}
	for _, c := range cases {
		u, ok := parseDateFast(c.s, c.year)
		if ok != c.ok {
			t.Errorf("parseDateFast(%q): ok=%v want %v", c.s, ok, c.ok)
			continue
		}
		if ok && u == 0 {
			t.Errorf("parseDateFast(%q): unix=0", c.s)
		}
	}
}

func TestValidLevel(t *testing.T) {
	good := []string{"INFO", "info", "WARN", "ERROR", "DEBUG", "TRACE", "FATAL", "W", "I", "Warning", "SEVERE", "CRITICAL"}
	for _, s := range good {
		if !validLevel([]byte(s)) {
			t.Errorf("validLevel(%q) = false, want true", s)
		}
	}
	bad := []string{"hello-world", "com.xxl.X", "[main]", "user", "", "signed"}
	for _, s := range bad {
		if validLevel([]byte(s)) {
			t.Errorf("validLevel(%q) = true, want false", s)
		}
	}
}

func TestValidThread(t *testing.T) {
	good := []string{"main", "http-nio-8080-exec-3", "pool-1-thread-1", "main thread"}
	for _, s := range good {
		if !validThread([]byte(s)) {
			t.Errorf("validThread(%q) = false, want true", s)
		}
	}
	bad := []string{"", "[main]", "a very long run of text that clearly swallowed the rest of the line"}
	for _, s := range bad {
		if validThread([]byte(s)) {
			t.Errorf("validThread(%q) = true, want false", s)
		}
	}
}

// TestDetectMixedFormats exercises a file that switches format part-way
// through (Pinpoint-style block, then Spring Boot block). Both formats should
// be detected and each line parsed with its own columns rather than swallowed.
func TestDetectMixedFormats(t *testing.T) {
	dir := t.TempDir()
	path := dir + "\\mix.log"
	var sb []byte
	// Pinpoint-style block
	for i := 0; i < 120; i++ {
		sb = append(sb, []byte(fmt.Sprintf("08-16 21:30:%02d.9%02d %s LoggerA%d : pinpoint msg %d\n",
			22+i/60, i%100, []string{"INFO", "WARN", "ERROR", "DEBUG"}[i%4], i, i))...)
	}
	// Spring Boot style block
	for i := 0; i < 280; i++ {
		sb = append(sb, []byte(fmt.Sprintf("2026-08-16 21:31:%02d.%03d  INFO 7 --- [main] s.c.a.AnnotationConfigApplicationContext : spring msg %d\n",
			10+i/60, (i*13)%1000, i))...)
	}
	writeLog(path, string(sb))

	pl, err := parseLogFile(path, 2026, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer pl.Close()
	if pl.Format == nil || !pl.AutoDetected {
		t.Fatal("expected an auto-detected format")
	}
	if pl.AltFormat == nil {
		t.Fatalf("expected a secondary format for the mixed file, got primary %q only", pl.FormatStr)
	}
	if len(pl.Records) != 400 {
		t.Fatalf("expected 400 records, got %d", len(pl.Records))
	}

	// A Pinpoint line
	r0 := pl.Records[0]
	if r0.Logger != "LoggerA0" || r0.Msg != "pinpoint msg 0" {
		t.Errorf("r0: logger=%q msg=%q", r0.Logger, r0.Msg)
	}
	if r0.Time != "08-16 21:30:22.900" {
		t.Errorf("r0 time: %q", r0.Time)
	}
	// A Spring Boot line (first Spring record, right after the Pinpoint block)
	rs := pl.Records[120]
	if rs.Logger != "s.c.a.AnnotationConfigApplicationContext" {
		t.Errorf("spring logger: %q", rs.Logger)
	}
	if rs.Thread != "main" {
		t.Errorf("spring thread: %q", rs.Thread)
	}
	if rs.Msg != "spring msg 0" {
		t.Errorf("spring msg: %q", rs.Msg)
	}
	if rs.Time != "2026-08-16 21:31:10.000" {
		t.Errorf("spring time: %q", rs.Time)
	}
}

// TestRealSample runs detection on the bundled real-world log to make sure it
// still parses into time/level/logger columns and the msg is populated.
func TestRealSample(t *testing.T) {
	pl, err := parseLogFile("../xxl.log", 2026, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer pl.Close()
	t.Logf("detected format: %q (auto=%v)", pl.FormatStr, pl.AutoDetected)
	if pl.Format != nil {
		hasMsg := 0
		for _, r := range pl.Records {
			if r.Msg != "" {
				hasMsg++
			}
		}
		t.Logf("records=%d withMsg=%d", len(pl.Records), hasMsg)
		if hasMsg == 0 {
			t.Error("no records captured a msg column")
		}
	}
}
