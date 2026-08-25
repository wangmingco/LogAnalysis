// Utility helpers for the log comparison view: JSON / SQL formatting,
// regex replace, and a line + character level diff.

import * as diff from 'diff';

// formatJSON tries to pretty-print text as JSON. When the text is a log line
// that embeds JSON after a prefix, only the JSON portion is reformatted and the
// prefix is kept on its own line. Returns null when no valid JSON is found.
export function formatJSON(input) {
    const text = (input || '').trim();
    if (!text) return null;
    const tryParse = (s) => {
        try {
            return JSON.stringify(JSON.parse(s), null, 2);
        } catch {
            return null;
        }
    };
    const whole = tryParse(text);
    if (whole !== null) return whole;
    let s = -1;
    const sb = text.indexOf('{');
    const ss = text.indexOf('[');
    if (sb >= 0 && ss >= 0) s = Math.min(sb, ss);
    else s = Math.max(sb, ss);
    if (s < 0) return null;
    const partial = tryParse(text.slice(s));
    if (partial === null) return null;
    const prefix = text.slice(0, s).trim();
    return prefix ? prefix + '\n' + partial : partial;
}

const SQL_BREAK_KEYWORDS = new Set([
    'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'JOIN', 'LEFT', 'RIGHT', 'INNER',
    'OUTER', 'CROSS', 'FULL', 'ON', 'GROUP', 'ORDER', 'HAVING', 'LIMIT',
    'OFFSET', 'UNION', 'ALL', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER',
    'DROP', 'SET', 'VALUES', 'WITH', 'RETURNING', 'MERGE', 'WHEN', 'ELSE', 'END',
]);

// formatSQL applies a light-weight, keyword-driven pretty printer. Returns the
// original string when no SQL is detected.
export function formatSQL(input) {
    const text = (input || '').trim();
    if (!text) return null;
    if (!/\b(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|FROM|WHERE|JOIN)\b/i.test(text)) {
        return null;
    }
    const tokenRe = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`|--[^\n]*|\/\*[\s\S]*?\*\/|\b[A-Za-z_][A-Za-z0-9_]*\b|[(),;]|\s+/g;
    const tokens = [];
    let m;
    while ((m = tokenRe.exec(text)) !== null) {
        if (/^\s+$/.test(m[0])) continue;
        tokens.push(m[0]);
    }

    const lines = [];
    let indent = 0;
    let line = '';
    const flush = () => {
        if (line.trim() !== '') lines.push('  '.repeat(indent) + line.trim());
        line = '';
    };
    for (const raw of tokens) {
        const tok = raw.trim();
        if (tok === '(') {
            flush();
            lines.push('  '.repeat(indent) + '(');
            indent++;
        } else if (tok === ')') {
            flush();
            indent = Math.max(0, indent - 1);
            lines.push('  '.repeat(indent) + ')');
        } else if (tok === ';') {
            line += ';';
            flush();
        } else if (SQL_BREAK_KEYWORDS.has(tok.toUpperCase())) {
            flush();
            lines.push('  '.repeat(indent) + tok.toUpperCase());
        } else {
            line += (line ? ' ' : '') + tok;
        }
    }
    flush();
    return lines.join('\n');
}

// regexReplace applies a global (and optionally case-insensitive) regex replace.
// Returns null when the pattern is invalid.
export function regexReplace(text, pattern, replacement, {ignoreCase = false} = {}) {
    if (!pattern) return text;
    let flags = 'g';
    if (ignoreCase) flags += 'i';
    try {
        const re = new RegExp(pattern, flags);
        return text.replace(re, replacement);
    } catch {
        return null;
    }
}

// diffLines computes a diff between two texts using the jsdiff library.
// Line-aligned rows are emitted as {type:'same'}, lines present on only one
// side as {type:'del'|'add'}, and a line replaced by another line becomes
// {type:'mod'} carrying a character/word-level diff ({aParts}/{bParts}) so only
// the differing fragments are highlighted.
export function diffLines(aText, bText) {
    const A = (aText || '').split('\n');
    const B = (bText || '').split('\n');
    const n = A.length;
    const m = B.length;

    // Line LCS dynamic programming (guarded for pathological sizes).
    const cap = 800;
    let rows;
    if (n > cap || m > cap) {
        rows = [];
        const max = Math.max(n, m);
        for (let i = 0; i < max; i++) {
            if (i < n && i < m) {
                if (A[i] === B[i]) rows.push({type: 'same', text: A[i]});
                else rows.push({type: 'del', text: A[i]}, {type: 'add', text: B[i]});
            } else if (i < n) {
                rows.push({type: 'del', text: A[i]});
            } else {
                rows.push({type: 'add', text: B[i]});
            }
        }
    } else {
        const dp = Array.from({length: n + 1}, () => new Uint16Array(m + 1));
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
            }
        }
        rows = [];
        let i = 0;
        let j = 0;
        while (i < n && j < m) {
            if (A[i] === B[j]) {
                rows.push({type: 'same', text: A[i]});
                i++;
                j++;
            } else if (dp[i + 1][j] >= dp[i][j + 1]) {
                rows.push({type: 'del', text: A[i]});
                i++;
            } else {
                rows.push({type: 'add', text: B[j]});
                j++;
            }
        }
        while (i < n) {
            rows.push({type: 'del', text: A[i]});
            i++;
        }
        while (j < m) {
            rows.push({type: 'add', text: B[j]});
            j++;
        }
    }

    // Merge each contiguous run of {del, add} into a character-level 'mod' pair
    // when it is exactly one line replaced by one line.
    const out = [];
    let k = 0;
    while (k < rows.length) {
        if (rows[k].type === 'same') {
            out.push(rows[k]);
            k++;
            continue;
        }
        const run = [];
        while (k < rows.length && rows[k].type !== 'same') {
            run.push(rows[k]);
            k++;
        }
        const dels = run.filter(r => r.type === 'del');
        const adds = run.filter(r => r.type === 'add');
        if (dels.length === 1 && adds.length === 1) {
            const {aParts, bParts} = diffWords(dels[0].text, adds[0].text);
            out.push({type: 'mod', a: dels[0].text, b: adds[0].text, aParts, bParts});
        } else {
            out.push(...run);
        }
    }
    return out;
}

// diffWords highlights the differing fragments between two lines using jsdiff.
// Words are kept intact (whitespace preserved) so the identical middle of two
// long lines stays unmarked instead of being flagged as all-different.
function diffWords(a, b) {
    const changes = diff.diffWordsWithSpace(a, b);
    const aParts = [];
    const bParts = [];
    for (const ch of changes) {
        if (ch.added) {
            bParts.push({text: ch.value, kind: 'ins'});
        } else if (ch.removed) {
            aParts.push({text: ch.value, kind: 'del'});
        } else {
            aParts.push({text: ch.value, kind: 'same'});
            bParts.push({text: ch.value, kind: 'same'});
        }
    }
    return {aParts: mergeParts(aParts), bParts: mergeParts(bParts)};
}

function mergeParts(parts) {
    const out = [];
    for (const p of parts) {
        const last = out[out.length - 1];
        if (last && last.kind === p.kind) last.text += p.text;
        else out.push({text: p.text, kind: p.kind});
    }
    return out;
}