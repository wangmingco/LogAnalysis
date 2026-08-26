import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';

const ROW_H = 36;
const OVERSCAN = 12;

function Highlight({text, keywords}) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const kws = useMemo(() => (keywords || []).filter(k => k).sort((a, b) => b.length - a.length), [keywords]);
    const re = useMemo(() => kws.length ? new RegExp('(' + kws.map(esc).join('|') + ')', 'gi') : null, [kws]);
    if (!kws.length) return <>{text}</>;
    const parts = text.split(re);
    return (
        <>
            {parts.map((p, i) =>
                kws.some(k => p.toLowerCase() === k.toLowerCase())
                    ? <mark className="hl" key={i}>{p}</mark>
                    : <span key={i}>{p}</span>
            )}
        </>
    );
}

function LevelBadge({level}) {
    const lv = (level || '').toUpperCase();
    return <span className={`lvl lvl-${lv.toLowerCase() || 'none'}`}>{lv || '—'}</span>;
}

function ResultList({entries, total, physical, folded, selected, setSelected, loadMore, busy, multi, keywords, formatActive, logFormat, onDoubleClickCell, compareOpen, compareQueue, compareLeftKey, compareRightKey, onToggleComparePanel, onToggleCompare, onExport}) {
    const scrollRef = useRef(null);
    const wrapRef = useRef(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportH, setViewportH] = useState(0);
    const loadingRef = useRef(false);

    // context menu + highlight range
    const [menu, setMenu] = useState(null);      // {x, y, refIdx}
    const [menuN, setMenuN] = useState(10);
    const [hlSet, setHlSet] = useState(null);    // Set of "lineNo|file" keys
    const menuRef = useRef(null);

    // column visibility (per-column right-click -> hide)
    const [hiddenCols, setHiddenCols] = useState(new Set());
    const [colMenu, setColMenu] = useState(null); // {x, y, colId}

    const FORMAT_COLS = [
        {id: 'line', label: '行号'},
        {id: 'file', label: '文件'},
        {id: 'time', label: '时间'},
        {id: 'level', label: '级别'},
        {id: 'thread', label: '线程'},
        {id: 'logger', label: 'Logger'},
        {id: 'msg', label: '消息'},
    ];
    const PLAIN_COLS = [
        {id: 'line', label: '行号'},
        {id: 'file', label: '文件'},
        {id: 'msg', label: '内容'},
    ];

    const allCols = formatActive ? FORMAT_COLS : PLAIN_COLS;
    const headerCols = useMemo(
        () => allCols.filter(c => c.id !== 'file' || multi),
        [allCols, multi]
    );
    const bodyCols = useMemo(
        () => headerCols.filter(c => !hiddenCols.has(c.id)),
        [headerCols, hiddenCols]
    );

    const hideCol = (colId) => {
        setHiddenCols(prev => new Set(prev).add(colId));
        setColMenu(null);
    };

    const showCol = (colId) => {
        setHiddenCols(prev => {
            const next = new Set(prev);
            next.delete(colId);
            return next;
        });
        setColMenu(null);
    };

    const showAllCols = () => {
        setHiddenCols(new Set());
        setColMenu(null);
    };

    const openColMenu = (e, colId) => {
        e.preventDefault();
        e.stopPropagation();
        const wrap = wrapRef.current;
        const rect = wrap ? wrap.getBoundingClientRect() : {left: 0, top: 0};
        setMenu(null);
        setColMenu({x: e.clientX - rect.left, y: e.clientY - rect.top, colId});
    };

    const keyOf = (e) => e.lineNo + '|' + e.fileName;

    const onScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        setScrollTop(el.scrollTop);
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60 && !loadingRef.current && entries.length < total) {
            loadingRef.current = true;
            loadMore().finally(() => { loadingRef.current = false; });
        }
    }, [loadMore, entries.length, total]);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
        ro.observe(el);
        setViewportH(el.clientHeight);
        return () => ro.disconnect();
    }, []);

    // close menu on outside click / Escape
    useEffect(() => {
        const close = (e) => {
            if (menuRef.current && menuRef.current.contains(e.target)) return;
            setMenu(null);
            setColMenu(null);
        };
        const esc = (e) => { if (e.key === 'Escape') { setMenu(null); setColMenu(null); } };
        window.addEventListener('mousedown', close);
        window.addEventListener('keydown', esc);
        return () => {
            window.removeEventListener('mousedown', close);
            window.removeEventListener('keydown', esc);
        };
    }, []);

    // clear highlight when results change
    useEffect(() => { setHlSet(null); }, [entries]);

    const openMenu = (e, idx) => {
        e.preventDefault();
        e.stopPropagation();
        const wrap = wrapRef.current;
        const rect = wrap ? wrap.getBoundingClientRect() : {left: 0, top: 0};
        setColMenu(null);
        setMenu({x: e.clientX - rect.left, y: e.clientY - rect.top, refIdx: idx});
    };

    const applyRange = (type) => {
        if (!menu) return;
        const refIdx = menu.refIdx;
        const n = Math.max(1, Math.floor(Number(menuN) || 10));
        let lo, hi;
        if (type.startsWith('row')) {
            if (type === 'rowBefore') { lo = refIdx - n; hi = refIdx; }
            else if (type === 'rowAfter') { lo = refIdx; hi = refIdx + n; }
            else { lo = refIdx - n; hi = refIdx + n; }
            lo = Math.max(0, lo);
            hi = Math.min(entries.length - 1, hi);
        } else {
            const refUnix = entries[refIdx] ? entries[refIdx].unix || 0 : 0;
            let tLo, tHi;
            if (type === 'secBefore') { tLo = refUnix - n; tHi = refUnix; }
            else if (type === 'secAfter') { tLo = refUnix; tHi = refUnix + n; }
            else { tLo = refUnix - n; tHi = refUnix + n; }
            const set = new Set();
            for (let i = 0; i < entries.length; i++) {
                const u = entries[i].unix || 0;
                if (u >= tLo && u <= tHi) set.add(keyOf(entries[i]));
            }
            setHlSet(set);
            setMenu(null);
            return;
        }
        const set = new Set();
        for (let i = lo; i <= hi; i++) {
            if (entries[i]) set.add(keyOf(entries[i]));
        }
        setHlSet(set);
        setMenu(null);
    };

    const startIdx = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const visibleCount = Math.ceil(viewportH / ROW_H) + OVERSCAN * 2;
    const endIdx = Math.min(entries.length, startIdx + visibleCount);

    const visible = useMemo(
        () => entries.slice(startIdx, endIdx),
        [entries, startIdx, endIdx]
    );

    const selKey = selected ? selected.lineNo + '|' + selected.fileName : null;

    const cellDouble = (e, value) => {
        e.stopPropagation();
        onDoubleClickCell(value);
    };

    const renderCell = (value, className, e, key, title) => {
        const cls = `${className} dbl`;
        return (
            <span
                key={key}
                className={cls}
                title={title || value}
                onDoubleClick={(ev) => cellDouble(ev, value)}
            >{value}</span>
        );
    };

    const renderCellFor = (col, e) => {
        switch (col.id) {
            case 'line':
                return renderCell(e.lineNo, 'row-line bg-line', e, 'c-line');
            case 'file':
                return renderCell(e.fileName, 'row-file bg-file', e, 'c-file', e.fileName);
            case 'time':
                return renderCell(e.time, 'row-time bg-time', e, 'c-time');
            case 'level':
                return (
                    <span key="c-lvl" className="lvl-row bg-level dbl" onDoubleClick={(ev) => cellDouble(ev, e.level)}>
                        <LevelBadge level={e.level} />
                    </span>
                );
            case 'thread':
                return e.thread && renderCell(e.thread, 'row-thread bg-thread', e, 'c-thread', e.thread);
            case 'logger':
                return renderCell(e.logger, 'row-logger bg-logger', e, 'c-logger', e.logger);
            case 'msg':
            default:
                if (formatActive) {
                    return (
                        <span key="c-msg" className="row-msg bg-msg dbl" onDoubleClick={(ev) => cellDouble(ev, e.msg)}>
                            <Highlight text={e.msg} keywords={keywords} />
                        </span>
                    );
                }
                return (
                    <span key="c-msg" className="row-msg plain-msg bg-msg dbl" onDoubleClick={(ev) => cellDouble(ev, e.text)}>
                        <Highlight text={e.text} keywords={keywords} />
                    </span>
                );
        }
    };

    const renderHeaderCell = (col) => {
        const hidden = hiddenCols.has(col.id);
        const cls = `rcol row-${col.id}${hidden ? ' hidden' : ''}`;
        return (
            <span
                key={col.id}
                className={cls}
                title={hidden
                    ? `点击显示"${col.label}"列（或右键菜单）`
                    : `点击隐藏"${col.label}"列（或右键菜单）`}
                onClick={() => (hidden ? showCol(col.id) : hideCol(col.id))}
                onContextMenu={(e) => openColMenu(e, col.id)}
            >{col.label}</span>
        );
    };

    return (
        <div className="result-wrap" ref={wrapRef}>
            <div className="result-head">
                <span className="rh-title">匹配结果</span>
                <span className="rh-total">
                    {total} 条记录（物理行 {physical}，折叠行 {folded}） · 已加载 {entries.length}
                </span>
                {entries.length > 0 && (
                    <span className="rh-compare">
                        <button
                            className={`btn ghost mini ${compareOpen ? 'on' : ''}`}
                            onClick={onToggleComparePanel}
                            title="打开对比面板，右键日志行加入对比队列"
                        >对比</button>
                        <button
                            className="btn ghost mini"
                            onClick={() => onExport(bodyCols.map(c => c.id))}
                            title="导出当前显示的列和过滤后的全部匹配结果"
                        >导出</button>
                    </span>
                )}
                {entries.length > 0 && (
                    <span className="rh-cols">
                        {headerCols.map(renderHeaderCell)}
                    </span>
                )}
            </div>
            <div className="result-scroll" ref={scrollRef} onScroll={onScroll}>
                {entries.length === 0 && (
                    <div className="result-empty">
                        {busy
                            ? '正在加载…'
                            : total === 0
                                ? '没有匹配的记录，请调整时间范围或关键字后重试'
                                : '加载文件并设置条件后，点击"开始过滤"查看结果'}
                    </div>
                )}
                {entries.length > 0 && (
                    <>
                        <div className="rs-spacer" style={{height: startIdx * ROW_H}} />
                        <div className="rs-window">
                            {visible.map((e, vi) => {
                                const key = keyOf(e);
                                const absIdx = startIdx + vi;
                                const highlighted = hlSet && hlSet.has(key);
                                const inQueue = compareQueue.some(c => keyOf(c) === key);
                                const rowCmp = compareLeftKey === key ? 'cmp-left' : compareRightKey === key ? 'cmp-right' : inQueue ? 'cmp-in' : '';
                                return (
                                    <div
                                        key={key}
                                        className={`log-row ${formatActive ? 'cols' : 'plain'} ${selKey === key ? 'active' : ''} ${highlighted ? 'hl-range' : ''} ${rowCmp}`}
                                        onClick={() => setSelected(e)}
                                        onContextMenu={(ev) => openMenu(ev, absIdx)}
                                    >
                                        {bodyCols.map(c => renderCellFor(c, e))}
                                    </div>
                                );
                            })}
                        </div>
                        <div className="rs-spacer" style={{height: (entries.length - endIdx) * ROW_H}} />
                    </>
                )}
                <div className="sentinel">
                    {entries.length < total && <span>加载更多…</span>}
                </div>
            </div>

            {menu && (
                <div
                    className="ctx-menu"
                    ref={menuRef}
                    style={{left: menu.x, top: menu.y}}
                    onContextMenu={e => e.preventDefault()}
                >
                    <div className="ctx-head">对比</div>
                    <div className="ctx-btns">
                        <button onClick={() => {
                            const e = entries[menu.refIdx];
                            if (e) onToggleCompare(e);
                            setMenu(null);
                        }}>
                            {menu.refIdx < entries.length && compareQueue.some(c => keyOf(c) === keyOf(entries[menu.refIdx]))
                                ? '移除对比'
                                : '加入对比'}
                        </button>
                    </div>
                    <div className="ctx-sep" />
                    <div className="ctx-head">范围选择</div>
                    <div className="ctx-num">
                        <span>数量 N</span>
                        <input
                            type="number"
                            min={1}
                            value={menuN}
                            onChange={e => setMenuN(e.target.value)}
                            onKeyDown={e => e.stopPropagation()}
                        />
                    </div>
                    <div className="ctx-section">按行</div>
                    <div className="ctx-btns">
                        <button onClick={() => applyRange('rowBefore')}>前 N 行</button>
                        <button onClick={() => applyRange('rowAfter')}>后 N 行</button>
                        <button onClick={() => applyRange('rowBoth')}>前后 N 行</button>
                    </div>
                    <div className="ctx-section">按秒</div>
                    <div className="ctx-btns">
                        <button onClick={() => applyRange('secBefore')}>前 N 秒</button>
                        <button onClick={() => applyRange('secAfter')}>后 N 秒</button>
                        <button onClick={() => applyRange('secBoth')}>前后 N 秒</button>
                    </div>
                </div>
            )}

            {colMenu && (
                <div
                    className="ctx-menu"
                    ref={menuRef}
                    style={{left: colMenu.x, top: colMenu.y}}
                    onContextMenu={e => e.preventDefault()}
                >
                    <div className="ctx-head">列设置</div>
                    <div className="ctx-btns">
                        {hiddenCols.has(colMenu.colId)
                            ? <button onClick={() => showCol(colMenu.colId)}>显示该列</button>
                            : <button onClick={() => hideCol(colMenu.colId)}>隐藏该列</button>}
                        <button onClick={showAllCols}>显示全部列</button>
                    </div>
                </div>
            )}
        </div>
    );
}

export default ResultList;
