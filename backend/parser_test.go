package main

import (
	"fmt"
	"os"
	"testing"
)

func TestParseSample(t *testing.T) {
	pl, err := parseLogFile("../logs-from-pttlbdrc-report-finance-in-pttlbdrc-report-finance-56c7cdb8c8-fq8xz.log", 2026, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer pl.Close()
	fmt.Println("records:", len(pl.Records))
	// show first few
	for i := 0; i < 5 && i < len(pl.Records); i++ {
		r := pl.Records[i]
		fmt.Printf("rec[%d] off=%d len=%d line=%d hasTime=%v time=%q level=%q logger=%q unix=%d\n",
			i, r.Offset, r.Length, r.LineNo, r.HasTime, r.Time, r.Level, r.Logger, r.Unix)
	}
	// last
	if len(pl.Records) > 0 {
		r := pl.Records[len(pl.Records)-1]
		fmt.Printf("last line=%d time=%q\n", r.LineNo, r.Time)
	}
}

func TestFilter(t *testing.T) {
	pl, err := parseLogFile("../logs-from-pttlbdrc-report-finance-in-pttlbdrc-report-finance-56c7cdb8c8-fq8xz.log", 2026, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer pl.Close()
	res := filterLog(pl, FilterParams{Keywords: []string{"agentPath"}}, nil)
	fmt.Println("matches 'agentPath':", res.Total)
	entries := getPage(pl, res.Indices, 0, 5)
	for _, e := range entries {
		fmt.Printf("line=%d %s %s %s | %s\n", e.LineNo, e.Time, e.Level, e.Logger, e.Text)
	}
}

func TestLogbackPattern(t *testing.T) {
	// "2026-08-16 21:30:41,396 INFO  [main] com.pttl.X - hello world"
	dir := t.TempDir()
	path := dir + "\\pat.log"
	content := "2026-08-16 21:30:41,396 INFO  [main] com.pttl.X - hello world\n" +
		"2026-08-16 21:30:42,100 ERROR [http-1] com.pttl.Y - boom failed\n" +
		"   at com.pttl.Y.doSomething(X.java:10)\n" +
		"2026-08-16 21:30:43,000 WARN  [main] com.pttl.Z - note thing\n"
	writeFile(path, content)

	fp := compileRecordPattern("%date %-5level [%thread] %logger - %m%n")
	if fp == nil {
		t.Fatal("pattern did not compile")
	}
	pl, err := parseLogFile(path, 2026, fp)
	if err != nil {
		t.Fatal(err)
	}
	defer pl.Close()

	fmt.Println("pattern records:", len(pl.Records))
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
	if r0.Logger != "com.pttl.X" {
		t.Errorf("logger: %q", r0.Logger)
	}
	if r0.Msg != "hello world" {
		t.Errorf("msg: %q", r0.Msg)
	}

	// The ERROR record should include its continuation (stack trace).
	r1 := pl.Records[1]
	if r1.Level != "ERROR" || r1.Thread != "http-1" {
		t.Errorf("r1: %q %q", r1.Level, r1.Thread)
	}
	full := string(pl.readRecord(r1))
	if !containsStr(full, "at com.pttl.Y.doSomething") {
		t.Errorf("continuation not grouped: %q", full)
	}
}

func writeFile(path, content string) {
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		panic(err)
	}
}

func containsStr(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}
