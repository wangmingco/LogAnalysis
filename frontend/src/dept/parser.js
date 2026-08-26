// parser.js — 移植自 backend/parser.go
// 将日志文本解析为逻辑记录（带时间戳的头部 + 续行）。

import {detectFormats} from './detect.js';
import {parseDateFast, parsePatternUnix} from './date.js';

const timeRe = /^(?:(\d{4})-)?(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})([.,]\d+)?/;

export class ParsedLog {
    constructor() {
        this.path = '';
        this.name = '';
        this.size = 0;
        this.content = '';
        this.totalLines = 0;
        this.records = [];
        this.format = null;
        this.altFormat = null;
        this.formatStr = '';
        this.altFormatStr = '';
        this.autoDetected = false;
        this.dedupeKey = '';
    }
}

// lineSpans returns the physical-line span of every logical record.
export function lineSpans(pl) {
    const n = pl.records.length;
    const spans = new Array(n);
    for (let i = 0; i < n; i++) {
        spans[i] = i + 1 < n
            ? pl.records[i + 1].lineNo - pl.records[i].lineNo
            : pl.totalLines - pl.records[i].lineNo + 1;
    }
    return spans;
}

// readRecord returns the full raw text of a record (header + continuation lines).
export function readRecord(pl, rec) {
    return pl.content.slice(rec.offset, rec.offset + rec.length);
}

function atoi(b) {
    let n = 0;
    for (const c of b) {
        if (c < '0' || c > '9') break;
        n = n * 10 + (c.charCodeAt(0) - 48);
    }
    return n;
}

// parseLineBasic is the lightweight heuristic parser.
function parseLineBasic(ref, line, year) {
    const m = timeRe.exec(line);
    if (m === null) return;
    ref.hasTime = true;
    ref.time = m[0];

    let y = year;
    if (m[1]) y = atoi(m[1]);
    const mm = atoi(m[2]);
    const dd = atoi(m[3]);
    const hh = atoi(m[4]);
    const mi = atoi(m[5]);
    const ss = atoi(m[6]);
    ref.unix = Math.floor(new Date(y, mm - 1, dd, hh, mi, ss, 0).getTime() / 1000);

    let rest = line.slice(m[0].length);
    rest = rest.replace(/^ +/, '');
    let sp = rest.search(/[ \t]/);
    let levelTok;
    if (sp < 0) {
        levelTok = rest;
        rest = '';
    } else {
        levelTok = rest.slice(0, sp);
        rest = rest.slice(sp).replace(/^[ \t]+/, '');
    }
    ref.level = levelTok.toUpperCase();
    const ci = rest.indexOf(':');
    if (ci >= 0) {
        ref.logger = rest.slice(0, ci).trim();
        ref.msg = rest.slice(ci + 1).trim();
    } else {
        const j = rest.search(/[ \t]/);
        if (j >= 0) {
            ref.logger = rest.slice(0, j);
            ref.msg = rest.slice(j).trim();
        } else {
            ref.logger = rest;
        }
    }
}

// parseWithFormat parses a single line against a compiled pattern.
function parseWithFormat(ref, line, year, format) {
    const m = format.re.exec(line);
    format.re.lastIndex = 0;
    if (m === null) return false;
    const g = m.groups || {};
    ref.hasTime = true;
    if (g.date !== undefined) {
        ref.time = g.date;
        ref.unix = parsePatternUnix(ref.time, year);
    }
    if (g.level !== undefined) ref.level = g.level.toUpperCase();
    if (g.thread !== undefined) ref.thread = g.thread.trim();
    if (g.logger !== undefined) ref.logger = g.logger.trim();
    if (g.msg !== undefined) ref.msg = g.msg.trim();
    return true;
}

// parseLine returns a RecordRef for a single physical line.
function parseLine(raw, year, lineNo, offset, format, alt) {
    const ref = {offset, length: raw.length, lineNo, hasTime: false, time: '', level: '', logger: '', thread: '', msg: '', unix: 0};
    const line = raw.replace(/\r?\n$/, '');
    if (line.length === 0) return ref;
    if (format !== null) {
        if (parseWithFormat(ref, line, year, format)) return ref;
        if (alt !== null && parseWithFormat(ref, line, year, alt)) return ref;
    }
    parseLineBasic(ref, line, year);
    return ref;
}

// groupRecords merges a flat list of line refs (sorted by offset) into logical records.
function groupRecords(lines) {
    if (lines.length === 0) return [];
    const out = [];
    let cur = lines[0];
    for (let i = 1; i < lines.length; i++) {
        const ln = lines[i];
        if (ln.hasTime) {
            out.push(cur);
            cur = ln;
        } else {
            cur.length = (ln.offset + ln.length) - cur.offset;
        }
    }
    out.push(cur);
    return out;
}

const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

// parseLogText parses log text into a ParsedLog (async; yields periodically).
export async function parseLogText(content, size, path, name, year, format) {
    const pl = new ParsedLog();
    pl.path = path;
    pl.name = name || path;
    pl.size = size;
    pl.content = content;

    if (format !== null && format !== undefined) {
        pl.format = format;
        pl.formatStr = format.src;
    } else {
        const det = detectFormats(content, year);
        if (det.length > 0) {
            pl.format = det[0];
            pl.formatStr = det[0].src;
            pl.autoDetected = true;
            if (det.length > 1) {
                pl.altFormat = det[1];
                pl.altFormatStr = det[1].src;
            }
        }
    }
    const eff = pl.format;
    const alt = pl.altFormat;

    const refs = [];
    let lineNo = 0;
    let pos = 0;
    const len = content.length;
    while (pos < len) {
        const nl = content.indexOf('\n', pos);
        const end = nl < 0 ? len : nl + 1;
        const raw = content.slice(pos, end);
        lineNo++;
        refs.push(parseLine(raw, year, lineNo, pos, eff, alt));
        pos = end;
        if (lineNo % 5000 === 0) await yieldFrame();
    }

    pl.totalLines = lineNo;
    pl.records = groupRecords(refs);
    return pl;
}
