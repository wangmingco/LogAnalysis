import React, {useEffect, useRef, useState} from 'react';
import {diffLines, formatJSON, formatSQL, regexReplace} from '../lib/format';

function entryLabel(e, tag) {
    if (!e) return `${tag} —`;
    const file = e.fileName || '';
    const line = e.lineNo != null ? ` #${e.lineNo}` : '';
    const time = e.time ? ` · ${e.time}` : '';
    return `${tag}${file ? ' · ' + file : ''}${line}${time}`;
}

function DiffPane({rows, syncRef, peerRef}) {
    const onScroll = () => {
        if (syncRef && syncRef.current && peerRef && peerRef.current) {
            peerRef.current.scrollTop = syncRef.current.scrollTop;
        }
    };
    return (
        <div className="cmp-diff" ref={syncRef} onScroll={onScroll}>
            {rows.map((r, i) => (
                <div key={i} className={`cmp-dline ${r.type}`}>
                    <span className="cmp-dnum">{i + 1}</span>
                    {r.parts ? (
                        <span className="cmp-dtxt">
                            {r.parts.map((p, k) => (
                                <span key={k} className={`cmp-part ${p.kind}`}>{p.text}</span>
                            ))}
                        </span>
                    ) : (
                        <span className="cmp-dtxt">{r.text}</span>
                    )}
                </div>
            ))}
        </div>
    );
}

// CompareView is a fullscreen compare workspace: the compare queue sits at the
// top (right-click an item to place it on the left / right / remove it), and the
// placed entries are compared side by side below.
function CompareView({queue, leftKey, rightKey, entryKey, onClose, onRemove, onPlaceLeft, onPlaceRight, onClear}) {
    const left = queue.find(x => entryKey(x) === leftKey) || null;
    const right = queue.find(x => entryKey(x) === rightKey) || null;

    // The editors are intentionally UNCONTROLLED (defaultValue + refs): WebView2
    // can swallow the `input` event on freshly mounted fields, which would make a
    // controlled value reset on every re-render. We read the live value from the
    // DOM ref for every operation instead.
    const [aText, setAText] = useState('');
    const [bText, setBText] = useState('');
    const [active, setActive] = useState('A');
    const [view, setView] = useState('edit'); // 'edit' | 'diff'
    const [wrap, setWrap] = useState(true); // auto line wrap in panes
    const [menu, setMenu] = useState(null); // queue item context menu {x, y, key}
    const [reTarget, setReTarget] = useState(null);
    const [reBoth, setReBoth] = useState(false);
    const [reIgnore, setReIgnore] = useState(false);
    const [msg, setMsg] = useState('');
    const [err, setErr] = useState('');
    const [diffRows, setDiffRows] = useState(null);
    const [contentVer, setContentVer] = useState(0); // bumped on any editor change
    const [queueH, setQueueH] = useState(170);   // height of the queue list area
    const [queueMin, setQueueMin] = useState(false); // queue minimized
    const rootRef = useRef(null);
    const menuRef = useRef(null);
    const queueDrag = useRef(null);
    const aScroll = useRef(null);
    const bScroll = useRef(null);
    const aTextRef = useRef(null);
    const bTextRef = useRef(null);
    const rePatRef = useRef(null);
    const reRepRef = useRef(null);
    const msgTimer = useRef(null);

    // Sync the editors when placement changes.
    useEffect(() => {
        setAText(left ? left.text : '');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [leftKey]);
    useEffect(() => {
        setBText(right ? right.text : '');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rightKey]);

    // Close the queue item menu on outside click.
    useEffect(() => {
        const close = (e) => {
            if (menuRef.current && menuRef.current.contains(e.target)) return;
            setMenu(null);
        };
        window.addEventListener('mousedown', close);
        return () => window.removeEventListener('mousedown', close);
    }, []);

    useEffect(() => {
        const onKey = (e) => {
            if (e.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const freshText = (s) => {
        const ref = s === 'A' ? aTextRef : bTextRef;
        return ref.current ? ref.current.value : (s === 'A' ? aText : bText);
    };
    const setTextOf = (s, v) => {
        const ref = s === 'A' ? aTextRef : bTextRef;
        if (ref.current) ref.current.value = v;
        if (s === 'A') setAText(v);
        else setBText(v);
        setContentVer(n => n + 1);
    };
    const originalOf = (s) => (s === 'A' ? (left && left.text) : (right && right.text)) || '';

    // Focus the active editor when it appears (open / return to edit mode).
    useEffect(() => {
        if (reTarget || view !== 'edit') return;
        let n = 0;
        const tick = () => {
            const el = active === 'A' ? aTextRef.current : bTextRef.current;
            if (el && document.activeElement !== el) {
                el.focus();
                try {
                    el.setSelectionRange(el.value.length, el.value.length);
                } catch { /* ignore */ }
            }
            if (n++ < 5) setTimeout(tick, 60);
        };
        tick();
    }, [reTarget, view, active, leftKey, rightKey]);

    useEffect(() => {
        if (reTarget && rePatRef.current) {
            rePatRef.current.focus();
        }
    }, [reTarget]);

    const flash = (m) => {
        setMsg(m);
        if (msgTimer.current) clearTimeout(msgTimer.current);
        msgTimer.current = setTimeout(() => setMsg(''), 2000);
    };
    const setError = (m) => {
        setErr(m);
        if (msgTimer.current) clearTimeout(msgTimer.current);
        msgTimer.current = setTimeout(() => setErr(''), 3000);
    };

    // Run a formatter against the selected text of a pane when there is an
    // active selection, otherwise against the whole content. The formatted
    // result replaces only the selected range (the rest is left untouched) and
    // the formatted selection is re-selected for review.
    const doFormat = (s, fmt, okLabel, errMsg) => {
        setActive(s);
        const ref = s === 'A' ? aTextRef : bTextRef;
        const el = ref.current;
        if (!el) return;
        const full = el.value;
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const hasSel = end > start;
        const target = hasSel ? full.slice(start, end) : full;
        const res = fmt(target);
        if (res === null) {
            setError(errMsg);
            return;
        }
        if (hasSel) {
            const next = full.slice(0, start) + res + full.slice(end);
            setTextOf(s, next);
            el.focus();
            el.setSelectionRange(start, start + res.length);
            flash(`${okLabel}（选中部分，${s} 侧）`);
        } else {
            setTextOf(s, res);
            flash(`${okLabel}（${s} 侧）`);
        }
    };
    const doJSON = (s) => doFormat(s, formatJSON, '已格式化 JSON', '不是有效的 JSON，无法格式化');
    const doSQL = (s) => doFormat(s, formatSQL, '已格式化 SQL', '未检测到可格式化的 SQL');
    const doCopy = async (s) => {
        setActive(s);
        try {
            await navigator.clipboard.writeText(freshText(s));
            flash(`已复制 ${s} 侧内容`);
        } catch {
            setError('复制失败');
        }
    };
    const doRestore = (s) => {
        setActive(s);
        setTextOf(s, originalOf(s));
        flash(`已还原 ${s} 侧为原始内容`);
    };
    const openRegex = (s) => {
        setActive(s);
        setReTarget(s);
        setReBoth(false);
        setReIgnore(false);
    };
    const applyRegex = () => {
        const pat = rePatRef.current ? rePatRef.current.value : '';
        const rep = reRepRef.current ? reRepRef.current.value : '';
        const targets = reBoth ? ['A', 'B'] : [reTarget];
        let ok = true;
        for (const t of targets) {
            const res = regexReplace(freshText(t), pat, rep, {ignoreCase: reIgnore});
            if (res === null) {
                setError('正则表达式无效');
                ok = false;
                break;
            }
            setTextOf(t, res);
        }
        if (ok) {
            flash('已执行正则替换');
            setReTarget(null);
        }
    };

    // Recompute the diff from the live editors whenever diff mode is entered or
    // the placed entries change.
    useEffect(() => {
        if (view !== 'diff') {
            setDiffRows(null);
            return;
        }
        setDiffRows(diffLines(freshText('A'), freshText('B')));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [view, leftKey, rightKey, contentVer]);

    const diffLeft = (diffRows || []).filter(r => r.type !== 'add').map(r => (r.type === 'mod' ? {...r, parts: r.aParts} : r));
    const diffRight = (diffRows || []).filter(r => r.type !== 'del').map(r => (r.type === 'mod' ? {...r, parts: r.bParts} : r));
    const diffCount = (diffRows || []).reduce((n, r) => (r.type === 'same' ? n : n + 1), 0);

    const sideOf = (k) => (leftKey === k ? 'left' : rightKey === k ? 'right' : null);
    const openItemMenu = (e, item) => {
        e.preventDefault();
        e.stopPropagation();
        const rect = rootRef.current ? rootRef.current.getBoundingClientRect() : {left: 0, top: 0};
        setMenu({x: e.clientX - rect.left, y: e.clientY - rect.top, key: entryKey(item)});
    };

    // Drag the divider between the queue and the compare area to resize the queue.
    const startQueueDrag = (e) => {
        e.preventDefault();
        queueDrag.current = {startY: e.clientY, startH: queueMin ? 0 : queueH};
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
    };
    useEffect(() => {
        const onMove = (e) => {
            if (!queueDrag.current) return;
            const dy = e.clientY - queueDrag.current.startY;
            setQueueH(Math.min(320, Math.max(48, queueDrag.current.startH + dy)));
            setQueueMin(false);
        };
        const onUp = () => {
            queueDrag.current = null;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        };
    }, []);

    const paneHead = (side, label, hasEntry) => (
        <div className={`cmp-pane-head ${active === side ? 'active' : ''}`} onClick={() => setActive(side)}>
            <span className="cmp-pane-label">{label}</span>
            <div className="cmp-pane-actions">
                {hasEntry ? (
                    <>
                        <button className="btn ghost mini" title="格式化 JSON" onClick={(e) => { e.stopPropagation(); doJSON(side); }}>JSON</button>
                        <button className="btn ghost mini" title="格式化 SQL" onClick={(e) => { e.stopPropagation(); doSQL(side); }}>SQL</button>
                        <button className="btn ghost mini" title="正则替换" onClick={(e) => { e.stopPropagation(); openRegex(side); }}>正则</button>
                        <button className="btn ghost mini" title="复制内容" onClick={(e) => { e.stopPropagation(); doCopy(side); }}>复制</button>
                        <button className="btn ghost mini" title="还原为原始内容" onClick={(e) => { e.stopPropagation(); doRestore(side); }}>还原</button>
                    </>
                ) : (
                    <span className="cmp-pane-empty-tip">未放置</span>
                )}
            </div>
        </div>
    );

    return (
        <div className={`cmp-root ${wrap ? 'wrap' : ''}`} ref={rootRef}>
            {/* ---- Compare queue (top) ---- */}
            <div className="cmp-queue">
                <div className="cmp-queue-head">
                    <span className="cmp-queue-title">
                        对比队列 <span className="cmp-panel-count">{queue.length}</span>
                    </span>
                    <div className="cmp-queue-actions">
                        <button
                            className={`icon-btn ${queueMin ? '' : 'on'}`}
                            onClick={() => setQueueMin(m => !m)}
                            title={queueMin ? '展开对比队列' : '最小化对比队列'}
                        >{queueMin ? '▾' : '▴'}</button>
                        <button className="btn ghost mini" onClick={onClear} title="清空对比队列">清空</button>
                        <button className="btn ghost" onClick={onClose} title="关闭对比 (Esc)">关闭</button>
                    </div>
                </div>
                {!queueMin && (
                    <>
                        <div className="cmp-queue-hint">
                            日志行右键 →「加入对比」；此处列表右键 →「放入左侧 / 放入右侧」。
                        </div>
                        <div className="cmp-queue-list" style={{height: queueH}}>
                            {queue.length === 0 && (
                                <div className="cmp-panel-empty">队列为空，请在日志行上右键选择「加入对比」</div>
                            )}
                            {queue.map((item, i) => {
                                const k = entryKey(item);
                                const side = sideOf(k);
                                return (
                                    <div
                                        key={k}
                                        className={`cmp-queue-item${side ? ' side-' + side : ''}`}
                                        onContextMenu={(ev) => openItemMenu(ev, item)}
                                    >
                                        <span className={`cmp-panel-side${side ? ' side-' + side : ''}`}>
                                            {side === 'left' ? '左' : side === 'right' ? '右' : i + 1}
                                        </span>
                                        <div className="cmp-panel-item-body">
                                            <div className="cmp-panel-item-line">
                                                <span className="cmp-panel-lno">#{item.lineNo}</span>
                                                {item.fileName && <span className="cmp-panel-file">{item.fileName}</span>}
                                            </div>
                                            <div className="cmp-panel-item-meta">
                                                {item.time && <span className="cmp-panel-time">{item.time}</span>}
                                                <span className={`lvl lvl-${(item.level || '').toLowerCase()}`}>{item.level}</span>
                                                {item.logger && <span className="cmp-panel-logger">{item.logger}</span>}
                                            </div>
                                        </div>
                                        <button
                                            className="cmp-panel-x"
                                            title="移除"
                                            onClick={(ev) => { ev.stopPropagation(); onRemove(k); }}
                                        >×</button>
                                    </div>
                                );
                            })}
                        </div>
                    </>
                )}
            </div>

            <div
                className="cmp-vdrag"
                onMouseDown={startQueueDrag}
                title="拖动调整队列高度"
            />

            {/* ---- Text comparison (bottom) ---- */}
            <div className="cmp-compare-head">
                <span className="cmp-compare-stats">
                    {view === 'diff'
                        ? `差异 ${diffCount} 行`
                        : `A ${(freshText('A') || '').split('\n').length} 行 · B ${(freshText('B') || '').split('\n').length} 行`}
                </span>
                <div className="cmp-head-actions">
                    <button
                        className={`btn ghost mini ${wrap ? 'on' : ''}`}
                        onClick={() => setWrap(w => !w)}
                        title="切换自动换行"
                    >自动换行</button>
                    <button
                        className={`btn ghost mini ${view === 'diff' ? 'on' : ''}`}
                        onClick={() => setView(view === 'edit' ? 'diff' : 'edit')}
                        title="切换差异高亮 / 编辑模式"
                    >{view === 'edit' ? '差异高亮' : '编辑模式'}</button>
                </div>
            </div>

            <div className="cmp-body">
                {left ? (
                    <div className={`cmp-pane ${active === 'A' ? 'active' : ''}`}>
                        {paneHead('A', entryLabel(left, 'A'), true)}
                        {view === 'edit' ? (
                            <textarea
                                ref={aTextRef}
                                className="cmp-text"
                                defaultValue={aText}
                                onChange={e => { setAText(e.target.value); setContentVer(n => n + 1); }}
                                onFocus={() => setActive('A')}
                                spellCheck={false}
                                autoCapitalize="off"
                                autoCorrect="off"
                            />
                        ) : (
                            <DiffPane rows={diffLeft} syncRef={aScroll} peerRef={bScroll} />
                        )}
                    </div>
                ) : (
                    <div className="cmp-pane cmp-placeholder" onClick={() => setActive('A')}>
                        <span className="cmp-pane-empty-tip">请在上方队列中右键 →「放入左侧」</span>
                    </div>
                )}

                <div className="cmp-vdiv" />

                {right ? (
                    <div className={`cmp-pane ${active === 'B' ? 'active' : ''}`}>
                        {paneHead('B', entryLabel(right, 'B'), true)}
                        {view === 'edit' ? (
                            <textarea
                                ref={bTextRef}
                                className="cmp-text"
                                defaultValue={bText}
                                onChange={e => { setBText(e.target.value); setContentVer(n => n + 1); }}
                                onFocus={() => setActive('B')}
                                spellCheck={false}
                                autoCapitalize="off"
                                autoCorrect="off"
                            />
                        ) : (
                            <DiffPane rows={diffRight} syncRef={bScroll} peerRef={aScroll} />
                        )}
                    </div>
                ) : (
                    <div className="cmp-pane cmp-placeholder" onClick={() => setActive('B')}>
                        <span className="cmp-pane-empty-tip">请在上方队列中右键 →「放入右侧」</span>
                    </div>
                )}
            </div>

            {menu && (
                <div
                    className="ctx-menu cmp-panel-menu"
                    ref={menuRef}
                    style={{left: menu.x, top: menu.y}}
                    onContextMenu={e => e.preventDefault()}
                >
                    <div className="ctx-head">对比位置</div>
                    <div className="ctx-btns">
                        <button onClick={() => { onPlaceLeft(menu.key); setMenu(null); }}>放入左侧</button>
                        <button onClick={() => { onPlaceRight(menu.key); setMenu(null); }}>放入右侧</button>
                        <button className="danger" onClick={() => { onRemove(menu.key); setMenu(null); }}>移除</button>
                    </div>
                </div>
            )}

            {reTarget && (
                <div className="cmp-rebar">
                    <span className="cmp-re-title">正则替换（{reTarget} 侧）</span>
                    <input
                        ref={rePatRef}
                        className="cmp-re-in"
                        placeholder="正则表达式，如 \d{4}-\d{2}-\d{2}"
                        onKeyDown={e => { if (e.key === 'Enter') applyRegex(); }}
                    />
                    <input
                        ref={reRepRef}
                        className="cmp-re-in"
                        placeholder="替换为"
                        onKeyDown={e => { if (e.key === 'Enter') applyRegex(); }}
                    />
                    <label className="cmp-re-opt">
                        <input type="checkbox" checked={reBoth} onChange={e => setReBoth(e.target.checked)} /> 两侧
                    </label>
                    <label className="cmp-re-opt">
                        <input type="checkbox" checked={reIgnore} onChange={e => setReIgnore(e.target.checked)} /> 忽略大小写
                    </label>
                    <button className="btn primary mini" onClick={applyRegex}>替换</button>
                    <button className="btn ghost mini" onClick={() => setReTarget(null)}>取消</button>
                </div>
            )}

            {msg && <div className="cmp-msg">{msg}</div>}
            {err && <div className="cmp-err">{err}</div>}
        </div>
    );
}

export default CompareView;