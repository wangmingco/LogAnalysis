// filter.js — 移植自 backend/filter.go
// 过滤、分页、CSV 导出构建。

import {parseLayout} from './date.js';
import {lineSpans, readRecord} from './parser.js';

// parseDT parses a filter time string into a unix timestamp.
export function parseDT(year, s) {
    s = (s || '').trim();
    if (s === '') return {unix: 0, ok: false};
    const layouts = ['01-02 15:04:05', '01-02 15:04', '15:04:05', '15:04', '2006-01-02 15:04:05', '2006-01-02 15:04'];
    for (const l of layouts) {
        const u = parseLayout(l, s, year);
        if (u !== 0) return {unix: u, ok: true};
    }
    return {unix: 0, ok: false};
}

// filterLog matches records against params and returns matched indices.
export function filterLog(pl, params) {
    let startUnix = 0, endUnix = 0, hasStart = false, hasEnd = false;
    if (params.startTime) {
        const r = parseDT(params.year, params.startTime);
        if (r.ok) { startUnix = r.unix; hasStart = true; }
    }
    if (params.endTime) {
        const r = parseDT(params.year, params.endTime);
        if (r.ok) { endUnix = r.unix; hasEnd = true; }
    }
    const level = (params.level || '').toUpperCase().trim();
    const kws = [];
    for (const k of (params.keywords || [])) {
        const kk = (k || '').trim();
        if (kk !== '') kws.push(kk.toLowerCase());
    }

    const records = pl.records;
    if (records.length === 0) return {total: 0, indices: []};
    const needText = kws.length > 0;

    const matched = [];
    const content = pl.content;
    for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        if (hasStart && rec.unix < startUnix) continue;
        if (hasEnd && rec.unix > endUnix) continue;
        if (level !== '' && rec.level !== level) continue;
        if (needText) {
            const text = content.slice(rec.offset, rec.offset + rec.length).toLowerCase();
            let ok = true;
            for (const kw of kws) {
                if (!text.includes(kw)) { ok = false; break; }
            }
            if (!ok) continue;
        }
        matched.push(i);
    }
    return {total: matched.length, indices: matched};
}

// buildEntry materializes a LogEntry for a record.
export function buildEntry(pl, rec, fileName) {
    return {
        lineNo: rec.lineNo,
        time: rec.time,
        level: rec.level,
        logger: rec.logger,
        thread: rec.thread,
        msg: rec.msg,
        unix: rec.unix,
        hasTime: rec.hasTime,
        text: readRecord(pl, rec),
        fileName: fileName || '',
    };
}

// runFilter across multiple files, returning stats + a combined index.
export function runFilter(files, params) {
    if (files.length === 0) {
        return {total: 0, items: [], filesLoaded: 0, totalBytes: 0, physicalLines: 0, foldedLines: 0, message: '没有已加载的文件'};
    }
    const items = [];
    let totalBytes = 0, physicalLines = 0, foldedLines = 0;
    for (let fi = 0; fi < files.length; fi++) {
        const pl = files[fi];
        totalBytes += pl.size;
        const r = filterLog(pl, params);
        const spans = lineSpans(pl);
        for (const idx of r.indices) {
            items.push({file: fi, rec: idx});
            const sp = spans[idx];
            physicalLines += sp;
            foldedLines += sp - 1;
        }
    }
    return {total: items.length, items, filesLoaded: files.length, totalBytes, physicalLines, foldedLines};
}

// getPage materializes a page of entries from a combined result.
export function getPage(files, items, offset, limit) {
    if (offset < 0) offset = 0;
    if (limit <= 0) limit = 100;
    let start = offset;
    let end = offset + limit;
    if (start > items.length) start = items.length;
    if (end > items.length) end = items.length;
    const out = [];
    for (let i = start; i < end; i++) {
        const it = items[i];
        if (it.file >= files.length || it.rec >= files[it.file].records.length) continue;
        const pl = files[it.file];
        const rec = pl.records[it.rec];
        const fileName = files.length > 1 ? pl.name : '';
        out.push(buildEntry(pl, rec, fileName));
    }
    return out;
}

// getTimeRange returns the first/last timestamped record time across files.
export function getTimeRange(files) {
    let first = null, last = null;
    for (const pl of files) {
        for (const r of pl.records) {
            if (!r.hasTime) continue;
            if (first === null) first = r;
            last = r;
        }
    }
    if (first === null) return {min: '', max: ''};
    const fmt = (u) => {
        const d = new Date(u * 1000);
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    };
    return {min: fmt(first.unix), max: fmt(last.unix)};
}

// export helpers

const LABELS = {
    line: '行号', file: '文件', time: '时间', level: '级别',
    thread: '线程', logger: 'Logger', msg: '消息',
};
const PLAIN_MSG_LABEL = '内容';

function csvCell(v) {
    v = (v === null || v === undefined) ? '' : String(v);
    if (/[",\n\r]/.test(v)) {
        return '"' + v.replace(/"/g, '""') + '"';
    }
    return v;
}

// buildExportCsv builds the CSV body (without BOM) for the given visible columns.
export function buildExportCsv(cols, format, items, files) {
    const labels = {...LABELS};
    if (!format) labels.msg = PLAIN_MSG_LABEL;
    const header = cols.map((c) => labels[c] || c);
    const rows = [header];
    for (const it of items) {
        if (it.file >= files.length || it.rec >= files[it.file].records.length) continue;
        const pl = files[it.file];
        const rec = pl.records[it.rec];
        const row = [];
        for (const c of cols) {
            switch (c) {
                case 'line': row.push(String(rec.lineNo)); break;
                case 'file': row.push(pl.name); break;
                case 'time': row.push(rec.time); break;
                case 'level': row.push(rec.level); break;
                case 'thread': row.push(rec.thread); break;
                case 'logger': row.push(rec.logger); break;
                case 'msg': row.push(format ? rec.msg : readRecord(pl, rec)); break;
                default: row.push(''); break;
            }
        }
        rows.push(row);
    }
    return rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
}
