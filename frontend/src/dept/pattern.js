// pattern.js — 移植自 backend/pattern.go
// 将 logback/log4j 布局模式编译为带命名捕获组的 JS 正则。

export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Regex fragments for the individual log4j/logback conversion specifiers.
const dateRe = `(?<date>(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}-\\d{1,2})[ T]\\d{1,2}:\\d{2}(?::\\d{2}(?:[.,]\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?|\\d{1,2}:\\d{2}(?::\\d{2}(?:[.,]\\d+)?)?(?:Z|[+-]\\d{2}:?\\d{2})?)`;
const levelRe  = `(?<level>[^\\s]+)`;
const threadRe = `(?<thread>[^\\]\\r\\n]+)`;
const loggerRe = `(?<logger>[^\\s]+)`;
const msgRe    = `(?<msg>.+)`;
const classRe  = `(?<class>[^\\s]+)`;
const methodRe = `(?<method>[^\\s()]+)`;
const fileRe   = `(?<file>[^\\s:()]+)`;
const numRe    = `\\d+`;
const tokenRe  = `[^\\s]+`;
const uuidRe   = `[0-9a-fA-F-]{8,}`;

function conversionRegex(name) {
    switch (name) {
        case 'n': return [`\\s*`, true];
        case 'N': return [numRe, true];
        case 'd': return [dateRe, true];
        case 'p': return [levelRe, true];
        case 'c': return [loggerRe, true];
        case 'm': return [msgRe, true];
        case 't': return [threadRe, true];
        case 'T': return [numRe, true];
        case 'C': return [classRe, true];
        case 'M': return [methodRe, true];
        case 'L': return [numRe, true];
        case 'F': return [fileRe, true];
        case 'l': return [tokenRe, true];
        case 'r': return [numRe, true];
        case 'x': return [tokenRe, true];
        case 'X': return [tokenRe, true];
        case 'K': return [tokenRe, true];
        case 'u': return [uuidRe, true];
    }
    switch (name.toLowerCase()) {
        case 'date': return [dateRe, true];
        case 'level': case 'le': case 'levelshort': return [levelRe, true];
        case 'thread': case 'tn': case 'threadshort': case 'threadname': return [threadRe, true];
        case 'threadid': case 'tid': return [numRe, true];
        case 'logger': case 'lo': case 'loggername': return [loggerRe, true];
        case 'msg': case 'message': return [msgRe, true];
        case 'class': return [classRe, true];
        case 'method': return [methodRe, true];
        case 'line': return [numRe, true];
        case 'file': return [fileRe, true];
        case 'location': return [tokenRe, true];
        case 'pid': case 'processid': return [numRe, true];
        case 'relative': return [numRe, true];
        case 'ndc': return [tokenRe, true];
        case 'mdc': case 'map': return [tokenRe, true];
        case 'marker': return [tokenRe, true];
        case 'sn': case 'sequencenumber': return [numRe, true];
        case 'nano': return [numRe, true];
        case 'uuid': return [uuidRe, true];
        case 'threadpriority': case 'tp': return [numRe, true];
        case 'fqcn': return [tokenRe, true];
        case 'newline': return [`\\s*`, true];
    }
    return ['', false];
}

// litRegex turns literal text into regex, collapsing runs of whitespace to \s+.
function litRegex(lit) {
    let sb = '';
    let run = 0;
    const flush = () => {
        if (run > 0) { sb += `\\s+`; run = 0; }
    };
    for (let i = 0; i < lit.length; i++) {
        const c = lit[i];
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
            run++;
            continue;
        }
        flush();
        sb += escapeRe(c);
    }
    flush();
    return sb;
}

// logbackPattern compiles a logback/log4j layout pattern into a JS RegExp.
function logbackPattern(pattern) {
    let sb = '^';
    let hasField = false;
    let i = 0;
    while (i < pattern.length) {
        const c = pattern[i];
        if (c !== '%') {
            let j = i;
            while (j < pattern.length && pattern[j] !== '%') j++;
            sb += litRegex(pattern.slice(i, j));
            i = j;
            continue;
        }
        if (i + 1 < pattern.length && pattern[i + 1] === '%') {
            sb += `%`;
            i += 2;
            continue;
        }
        let j = i + 1;
        while (j < pattern.length && (pattern[j] === '-' || (pattern[j] >= '0' && pattern[j] <= '9'))) j++;
        let k = j;
        while (k < pattern.length && ((pattern[k] >= 'a' && pattern[k] <= 'z') || (pattern[k] >= 'A' && pattern[k] <= 'Z'))) k++;
        const name = pattern.slice(j, k);
        let skip = k;
        if (skip < pattern.length && pattern[skip] === '{') {
            let depth = 1;
            skip++;
            while (skip < pattern.length && depth > 0) {
                if (pattern[skip] === '{') depth++;
                else if (pattern[skip] === '}') depth--;
                skip++;
            }
        }

        const [rgx, known] = conversionRegex(name);
        if (known) {
            sb += rgx;
            if (name !== 'n' && name.toLowerCase() !== 'newline') hasField = true;
        } else {
            sb += escapeRe('%' + name);
        }
        i = skip;
    }

    if (!hasField) return null;
    sb += '$';
    return new RegExp(sb, 's');
}

// compileRecordPattern builds a compiled pattern object with field info.
export function compileRecordPattern(pattern) {
    const re = logbackPattern(pattern);
    if (re === null) return null;
    const order = ['date', 'level', 'thread', 'logger', 'msg'];
    const present = [];
    const index = {};
    for (const f of order) {
        if (re.source.includes('(?<' + f + '>')) {
            present.push(f);
            index[f] = present.length - 1;
        }
    }
    return {re, src: pattern, fields: present, index};
}
