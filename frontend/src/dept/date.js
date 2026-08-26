// date.js — 移植自 backend/detect.go (parseDateFast 等) 与 backend/parser.go (parsePatternUnix)
// 提供与 Go time 本地时区一致的 Unix 秒解析。

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function daysInMonth(mo, y) {
    switch (mo) {
        case 1: case 3: case 5: case 7: case 8: case 10: case 12: return 31;
        case 4: case 6: case 9: case 11: return 30;
        case 2: return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
    }
    return 0;
}

function atoiStr(s) {
    if (s === '') return {v: 0, ok: false};
    let n = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c < 48 || c > 57) break;
        n = n * 10 + (c - 48);
    }
    return {v: n, ok: true};
}

function isOffsetTail(t) {
    if (t === '') return true;
    for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if ((c < '0' || c > '9') && c !== ':') return false;
    }
    return true;
}

// parseDateFast parses common log4j/logback date outputs into a unix timestamp.
export function parseDateFast(s, year) {
    s = (s || '').trim();
    if (s === '') return {unix: 0, ok: false};
    s = s.replace('T', ' ');

    const li = Math.max(s.lastIndexOf('+'), s.lastIndexOf('-'));
    if (li > 0 && isOffsetTail(s.slice(li + 1))) s = s.slice(0, li);
    if (s.endsWith('Z') || s.endsWith('z')) s = s.slice(0, -1);

    let datePart = '', timePart = s, hasDate = false;
    const sp = s.indexOf(' ');
    if (sp >= 0) {
        datePart = s.slice(0, sp);
        timePart = s.slice(sp + 1);
        hasDate = true;
    }

    let h = 0, mi = 0, ss = 0;
    {
        const segs = timePart.split(':');
        if (segs.length < 2 || segs.length > 3) return {unix: 0, ok: false};
        let r = atoiStr(segs[0]);
        if (!r.ok) return {unix: 0, ok: false};
        h = r.v;
        r = atoiStr(segs[1]);
        if (!r.ok) return {unix: 0, ok: false};
        mi = r.v;
        if (segs.length === 3) {
            r = atoiStr(segs[2]);
            if (!r.ok) return {unix: 0, ok: false};
            ss = r.v;
        }
    }
    if (h > 23 || mi > 59 || ss > 60) return {unix: 0, ok: false};

    let mo = 1, d = 1;
    if (hasDate) {
        const segs = datePart.split('-');
        if (segs.length === 3) {
            const y = atoiStr(segs[0]);
            const m = atoiStr(segs[1]);
            const dd = atoiStr(segs[2]);
            if (!y.ok || !m.ok || !dd.ok) return {unix: 0, ok: false};
            year = y.v; mo = m.v; d = dd.v;
        } else if (segs.length === 2) {
            const m = atoiStr(segs[0]);
            const dd = atoiStr(segs[1]);
            if (!m.ok || !dd.ok) return {unix: 0, ok: false};
            mo = m.v; d = dd.v;
        } else {
            return {unix: 0, ok: false};
        }
    }
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(mo, year)) return {unix: 0, ok: false};

    return {unix: Math.floor(new Date(year, mo - 1, d, h, mi, ss, 0).getTime() / 1000), ok: true};
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// parseLayout parses a time layout string (Go-style 2006/01/02/15/04/05/Jan)
// against s and returns a unix timestamp. Defaults missing year to `year`.
export function parseLayout(layout, s, year) {
    s = (s || '').trim();
    if (!s) return 0;
    // strip a trailing offset / fraction handled loosely
    if (s.includes(',')) s = s.slice(0, s.indexOf(','));
    if (s.includes('.')) s = s.slice(0, s.indexOf('.'));

    const tokens = {
        '2006': {re: '(\\d{4})', kind: 'y'},
        '06': {re: '(\\d{2})', kind: 'yy'},
        '01': {re: '(\\d{1,2})', kind: 'mo'},
        '1': {re: '(\\d{1,2})', kind: 'mo'},
        '02': {re: '(\\d{1,2})', kind: 'd'},
        '2': {re: '(\\d{1,2})', kind: 'd'},
        '15': {re: '(\\d{1,2})', kind: 'h'},
        '03': {re: '(\\d{1,2})', kind: 'h'},
        '3': {re: '(\\d{1,2})', kind: 'h'},
        '04': {re: '(\\d{1,2})', kind: 'mi'},
        '4': {re: '(\\d{1,2})', kind: 'mi'},
        '05': {re: '(\\d{1,2})', kind: 's'},
        '5': {re: '(\\d{1,2})', kind: 's'},
        'Jan': {re: '([A-Za-z]{3})', kind: 'mon'},
        'January': {re: '([A-Za-z]+)', kind: 'mon'},
    };

    let re = '^';
    let i = 0;
    const seq = [];
    while (i < layout.length) {
        let matched = null;
        // long tokens first
        for (const tk of ['2006', 'January', '15', '03', '04', '05', 'Jan', '06', '01', '02', '1', '2', '3', '4', '5']) {
            if (layout.startsWith(tk, i) && tokens[tk]) {
                matched = tokens[tk];
                seq.push(matched.kind);
                re += matched.re;
                i += tk.length;
                break;
            }
        }
        if (matched) continue;
        // literal char (escape it), but collapse whitespace
        const c = layout[i];
        if (c === ' ' || c === '\t') {
            re += '\\s+';
            while (i < layout.length && (layout[i] === ' ' || layout[i] === '\t')) i++;
        } else {
            re += escapeRe(c);
            i++;
        }
    }
    re += '$';

    const m = s.match(re);
    if (!m) return 0;
    const caps = m.slice(1);

    let y = year, mo = 1, d = 1, h = 0, mi = 0, ss = 0;
    let ci = 0;
    for (const kind of seq) {
        const v = caps[ci++];
        switch (kind) {
            case 'y': y = parseInt(v, 10); break;
            case 'yy': y = 2000 + parseInt(v, 10); break;
            case 'mo': mo = parseInt(v, 10); break;
            case 'mon': mo = MONTHS.indexOf(v[0].toUpperCase() + v.slice(1).toLowerCase()) + 1; break;
            case 'd': d = parseInt(v, 10); break;
            case 'h': h = parseInt(v, 10); break;
            case 'mi': mi = parseInt(v, 10); break;
            case 's': ss = parseInt(v, 10); break;
        }
    }
    return Math.floor(new Date(y, mo - 1, d, h, mi, ss, 0).getTime() / 1000);
}

// parsePatternUnix mirrors backend parser.go.
export function parsePatternUnix(s, year) {
    const f = parseDateFast(s, year);
    if (f.ok) return f.unix;
    s = (s || '').trim();
    if (s === '') return 0;
    const layouts = ['2006-01-02 15:04:05', '2006-01-02 15:04', '01-02 15:04:05', '01-02 15:04', '02 Jan 2006 15:04:05'];
    for (const l of layouts) {
        const u = parseLayout(l, s, year);
        if (u !== 0) return u;
    }
    return 0;
}
