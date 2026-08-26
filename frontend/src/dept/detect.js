// detect.js — 移植自 backend/detect.go
// 自动识别 log4j/logback 布局模式（主格式 + 可选次格式）。

import {compileRecordPattern} from './pattern.js';
import {parseDateFast} from './date.js';

const autoDetectPatterns = [
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

    `%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level %logger{36} - %msg%n`,
    `%d{yyyy-MM-dd HH:mm:ss,SSS} %-5p %c - %m%n`,
    `%d{ISO8601} %-5p %c - %m%n`,
    `%d %-5level %logger - %msg%n`,
    `%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level %logger %msg%n`,
    `%d{yyyy-MM-dd HH:mm:ss} %-5p %c %m%n`,

    `[%d{yyyy-MM-dd HH:mm:ss,SSS}] [%t] %-5p %c - %m%n`,
    `[%d{yyyy-MM-dd HH:mm:ss,SSS}] %-5p %c - %m%n`,
    `[%d{yyyy-MM-dd HH:mm:ss.SSS}] [%thread] %-5level %logger - %msg%n`,
    `[%d{yyyy-MM-dd HH:mm:ss}] %-5level %logger - %msg%n`,

    `%-5p [%t] %c - %m%n`,
    `%-5level [%thread] %logger - %msg%n`,
    `%-5p %c - %m%n`,
    `[%-5level] %c{1.} %msg%n`,

    `%d{MM-dd HH:mm:ss.SSS} %-5level %logger : %msg%n`,
    `%d{MM-dd HH:mm:ss.SSS} %-5level %logger - %msg%n`,
    `%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level %logger : %msg%n`,
    `%d{yyyy-MM-dd HH:mm:ss} %level %logger : %msg%n`,

    `%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level [%thread] %C.%M(%F:%L) - %msg%n`,
    `%d{yyyy-MM-dd HH:mm:ss,SSS} %-5p [%t] %C.%M(%F:%L) - %m%n`,
    `%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level [%thread] %C.%M:%L - %msg%n`,
    `%d{ISO8601} %-5p [%t] %C.%M - %m%n`,

    `%r [%t] %p %c %x - %m%n`,
    `%d{ABSOLUTE} %-5p [%t] %c - %m%n`,
    `%r %p %c - %m%n`,

    `%d{yyyy-MM-dd HH:mm:ss.SSS} [%X{requestId}] [%thread] %-5level %logger - %msg%n`,
    `%d{yyyy-MM-dd HH:mm:ss.SSS} [%thread] [%X{requestId}] %-5level %logger - %msg%n`,

    `%d{yyyy-MM-dd HH:mm:ss.SSS}  %5level %pid --- [%thread] %logger : %msg%n`,
    `%d{yyyy-MM-dd HH:mm:ss.SSS} %5level %pid --- [%thread] %logger : %msg%n`,
    `%d{yyyy-MM-dd HH:mm:ss.SSS} %5level [%thread] %logger : %msg%n`,

    `%d{yyyy-MM-dd HH:mm:ss} %p %t %c - %m%n`,
    `%d{yyyy-MM-dd HH:mm:ss.SSS} %level %thread %logger - %msg%n`,
];

const compiledAutoPatterns = (() => {
    const seen = new Set();
    const out = [];
    for (const ps of autoDetectPatterns) {
        const rp = compileRecordPattern(ps);
        if (rp === null) continue;
        if (seen.has(rp.re.source)) continue;
        seen.add(rp.re.source);
        out.push(rp);
    }
    return out;
})();

const detectMaxLines = 150;
const detectMinLines = 3;
const detectUseScore = 0.8;
const multiWindowMin = 8 * 1024;

const continuationRe = /^(?:\s|Caused by:|Suppressed:|\.\.\.\s*\d+\s*more\b)/;

function isContinuationLine(line) {
    return continuationRe.test(line);
}

const knownLevels = new Set([
    'OFF', 'FATAL', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE', 'ALL',
    'SEVERE', 'WARNING', 'FINE', 'FINER', 'FINEST', 'CONFIG', 'NOTICE',
    'CRITICAL', 'ALERT', 'EMERGENCY', 'EMERG', 'PANIC', 'SUCCESS', 'FAILURE',
    'FAIL', 'NONE', 'TRC', 'DBG', 'INF', 'WRN', 'ERR', 'FTL', 'LOG',
]);

function validLevel(s) {
    if (!s || s.length === 0 || s.length > 8) return false;
    for (const c of s) {
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) return false;
    }
    if (knownLevels.has(s.toUpperCase())) return true;
    if (s.length <= 5) {
        for (const c of s) {
            if (c < 'A' || c > 'Z') return false;
        }
        return true;
    }
    return false;
}

function validThread(s) {
    s = (s || '').trim();
    if (s.length === 0 || s.length > 200) return false;
    if (hasBracket(s)) return false;
    if (/[ \t]/.test(s)) return s.length <= 16;
    return true;
}

function hasBracket(s) {
    return s.includes('[') || s.includes(']');
}

function scorePattern(rp, lines, year) {
    let matched = 0;
    let dateBad = 0, dateN = 0, levelBad = 0, levelN = 0;
    let thrBad = 0, thrN = 0, lgBad = 0, lgN = 0, msgBad = 0, msgN = 0;

    for (const ln of lines) {
        const m = rp.re.exec(ln);
        rp.re.lastIndex = 0;
        if (m === null) continue;
        matched++;
        const g = m.groups || {};
        if (g.date !== undefined) {
            dateN++;
            if (!parseDateFast(g.date, year).ok) dateBad++;
        }
        if (g.level !== undefined) {
            levelN++;
            if (!validLevel(g.level)) levelBad++;
        }
        if (g.thread !== undefined) {
            thrN++;
            if (!validThread(g.thread)) thrBad++;
        }
        if (g.logger !== undefined) {
            lgN++;
            if (hasBracket((g.logger || '').trim())) lgBad++;
        }
        if (g.msg !== undefined) {
            msgN++;
            const v = (g.msg || '').trim();
            if (v.length > 0 && (v[0] === '-' || v[0] === ':')) msgBad++;
        }
    }
    if (matched === 0) return 0;

    const matchRate = matched / lines.length;
    if (matchRate < 0.5) return matchRate * 0.3;
    let score = matchRate;

    if (dateN > 0) {
        score += (dateN - dateBad) / dateN >= 0.9 ? 0.06 : -0.2;
    }
    if (levelN > 0) {
        score += (levelN - levelBad) / levelN >= 0.6 ? 0.06 : -0.2;
    }
    if (thrN > 0) {
        score += thrBad === 0 ? 0.06 : -0.35;
    }
    if (lgN > 0) {
        score += lgBad === 0 ? 0.05 : -0.15;
    }
    if (msgN > 0 && msgBad / msgN >= 0.5) score -= 0.3;

    let nf = rp.fields.length;
    if (nf > 5) nf = 5;
    score += 0.015 * nf;
    return score;
}

// sampleWindows reads candidate header lines from up to three regions.
function sampleWindows(content, size) {
    const windows = [];
    const positions = [0];
    if (size > multiWindowMin) positions.push(Math.floor(size / 3), Math.floor(2 * size / 3));
    for (const pos of positions) {
        const lines = readSampleLinesAt(content, pos);
        if (lines.length >= detectMinLines) windows.push(lines);
    }
    return windows;
}

// readSampleLinesAt returns up to detectMaxLines non-empty candidate header lines.
function readSampleLinesAt(content, pos) {
    const out = [];
    let i = pos;
    while (out.length < detectMaxLines && i < content.length) {
        const nl = content.indexOf('\n', i);
        const end = nl < 0 ? content.length : nl;
        const ln = content.slice(i, end).replace(/\r$/, '');
        i = nl < 0 ? content.length : nl + 1;
        if (ln.length === 0) continue;
        if (isContinuationLine(ln)) continue;
        out.push(ln);
    }
    return out;
}

// detectFormats returns the dominant pattern first, optionally a second one.
export function detectFormats(content, year) {
    const size = content.length;
    const windows = sampleWindows(content, size);
    if (windows.length === 0) return [];

    let best = null;
    let bestScore = 0;
    for (const lines of windows) {
        if (lines.length < detectMinLines) continue;
        for (const rp of compiledAutoPatterns) {
            const s = scorePattern(rp, lines, year);
            if (s > bestScore) { bestScore = s; best = rp; }
        }
    }
    if (best === null || bestScore < detectUseScore) return [];

    let alt = null;
    let altScore = 0;
    for (const lines of windows) {
        const residual = [];
        for (const ln of lines) {
            const m = best.re.exec(ln);
            best.re.lastIndex = 0;
            if (m === null) residual.push(ln);
        }
        if (residual.length < 2) continue;
        for (const rp of compiledAutoPatterns) {
            if (rp === best || rp.re.source === best.re.source) continue;
            const s = scorePattern(rp, residual, year);
            if (s > altScore) { altScore = s; alt = rp; }
        }
    }

    const out = [best];
    if (alt !== null && altScore >= detectUseScore) out.push(alt);
    return out;
}
