import React, {useEffect, useRef, useState} from 'react';
import {GetTimeRange} from '../Dept';

const LEVELS = ['', 'TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

// Common log date/time formats -> ready-made log4j/logback template. Selecting
// one in the settings dialog fills the log format input with the template.
const DATE_FORMATS = [
    {label: 'MM-dd HH:mm:ss.SSS', value: '%date{MM-dd HH:mm:ss.SSS} %-5level [%thread] %logger - %m%n'},
    {label: 'yyyy-MM-dd HH:mm:ss.SSS', value: '%date{yyyy-MM-dd HH:mm:ss.SSS} %-5level [%thread] %logger - %m%n'},
    {label: 'yyyy-MM-dd HH:mm:ss', value: '%date{yyyy-MM-dd HH:mm:ss} %-5level [%thread] %logger - %m%n'},
    {label: 'yyyy-MM-dd HH:mm:ss,SSS', value: '%date{yyyy-MM-dd HH:mm:ss,SSS} %-5level [%thread] %logger - %m%n'},
    {label: 'MM-dd HH:mm:ss', value: '%date{MM-dd HH:mm:ss} %-5level [%thread] %logger - %m%n'},
    {label: 'dd/MM/yyyy HH:mm:ss', value: '%date{dd/MM/yyyy HH:mm:ss} %-5level [%thread] %logger - %m%n'},
    {label: "yyyy-MM-dd'T'HH:mm:ss.SSSXXX", value: "%date{yyyy-MM-dd'T'HH:mm:ss.SSSXXX} %-5level [%thread] %logger - %m%n"},
    {label: 'HH:mm:ss（仅时间）', value: '%date{HH:mm:ss} %-5level [%thread] %logger - %m%n'},
];

// Convert "YYYY-MM-DD HH:mm:ss" to a datetime-local input value "YYYY-MM-DDTHH:mm".
function toLocal(v) {
    if (!v) return '';
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!m) return '';
    const ss = m[6] ? `:${m[6]}` : '';
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}${ss}`;
}

// Format "YYYY-MM-DDTHH:mm:ss" -> "YYYY-MM-DD HH:mm:ss" for display.
function fmtDisplay(v) {
    if (!v) return '';
    return v.replace('T', ' ');
}

function pad(n) {
    return String(n).padStart(2, '0');
}

// A custom time field: shows "YYYY-MM-DD HH:mm:ss"; clicking opens a dropdown
// with a date picker plus hour/minute/second steppers. No native picker button.
function TimeField({value, min, max, onChange, placeholder}) {
    const [open, setOpen] = useState(false);
    const rootRef = useRef(null);

    const dt = (() => {
        if (!value) return null;
        const m = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
        if (!m) return null;
        return {
            y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: m[6] ? +m[6] : 0,
        };
    })();

    useEffect(() => {
        if (!open) return;
        const onDown = (e) => {
            if (rootRef.current && rootRef.current.contains(e.target)) return;
            setOpen(false);
        };
        window.addEventListener('mousedown', onDown);
        return () => window.removeEventListener('mousedown', onDown);
    }, [open]);

    const setPart = (part, val) => {
        const base = dt || {y: 2000, mo: 1, d: 1, h: 0, mi: 0, s: 0};
        const next = {...base, [part]: val};
        onChange(`${next.y}-${pad(next.mo)}-${pad(next.d)}T${pad(next.h)}:${pad(next.mi)}:${pad(next.s)}`);
    };

    return (
        <div className="time-field" ref={rootRef}>
            <button
                className={`time-display ${value ? '' : 'empty'}`}
                type="button"
                onClick={() => setOpen(o => !o)}
            >
                {dt ? <span className="time-value">{fmtDisplay(value)}</span> : <span className="time-placeholder">{placeholder}</span>}
                <span className="time-caret">▾</span>
            </button>
            {open && (
                <div className="time-picker">
                    <input
                        className="tp-date"
                        type="date"
                        value={dt ? `${dt.y}-${pad(dt.mo)}-${pad(dt.d)}` : ''}
                        min={min ? min.slice(0, 10) : undefined}
                        max={max ? max.slice(0, 10) : undefined}
                        onChange={e => {
                            const m = e.target.value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
                            if (m) {
                                const base = dt || {h: 0, mi: 0, s: 0};
                                setPart('y', +m[1]); setPart('mo', +m[2]); setPart('d', +m[3]);
                                // rebuild with base time preserved
                                onChange(`${m[1]}-${m[2]}-${m[3]}T${pad(base.h)}:${pad(base.mi)}:${pad(base.s)}`);
                            }
                        }}
                    />
                    <div className="tp-time">
                        <label>时</label><select value={dt ? dt.h : 0} onChange={e => setPart('h', +e.target.value)}>
                            {Array.from({length: 24}, (_, i) => <option key={i} value={i}>{pad(i)}</option>)}
                        </select>
                        <label>分</label><select value={dt ? dt.mi : 0} onChange={e => setPart('mi', +e.target.value)}>
                            {Array.from({length: 60}, (_, i) => <option key={i} value={i}>{pad(i)}</option>)}
                        </select>
                        <label>秒</label><select value={dt ? dt.s : 0} onChange={e => setPart('s', +e.target.value)}>
                            {Array.from({length: 60}, (_, i) => <option key={i} value={i}>{pad(i)}</option>)}
                        </select>
                    </div>
                    <div className="tp-actions">
                        <button type="button" className="btn small ghost" onClick={() => { onChange(''); setOpen(false); }}>清除</button>
                        <button type="button" className="btn small primary" onClick={() => setOpen(false)}>确定</button>
                    </div>
                </div>
            )}
        </div>
    );
}

function FilterBar({year, filter, onRun, busy, disabled, total, loadedCount, panelCollapsed, setPanelCollapsed, logFormat, setLogFormat, detectedFormats, onYearChange}) {
    const [startTime, setStartTime] = useState(filter.startTime || '');
    const [endTime, setEndTime] = useState(filter.endTime || '');
    const [level, setLevel] = useState(filter.level || '');
    const [keywords, setKeywords] = useState(filter.keywords || []);
    const [input, setInput] = useState('');
    const [minTime, setMinTime] = useState('');
    const [maxTime, setMaxTime] = useState('');
    const inputRef = useRef(null);
    const fmtInputRef = useRef(null);
    const [showFmtModal, setShowFmtModal] = useState(false);
    const [fmtInput, setFmtInput] = useState(logFormat);
    const [dateFmt, setDateFmt] = useState('');
    const [yearLocal, setYearLocal] = useState(year);

    useEffect(() => {
        setStartTime(filter.startTime || '');
        setEndTime(filter.endTime || '');
        setLevel(filter.level || '');
        setKeywords(filter.keywords || []);
    }, [filter]);

    // When the loaded file set changes, fetch the first/last record timestamps
    // and pre-fill the min/max time range into the start/end pickers.
    useEffect(() => {
        if (loadedCount === 0) return;
        GetTimeRange().then(r => {
            const mn = toLocal(r && r.min);
            const mx = toLocal(r && r.max);
            setMinTime(mn);
            setMaxTime(mx);
            setStartTime(prev => prev || mn || '');
            setEndTime(prev => prev || mx || '');
        });
    }, [loadedCount]);

    const submitKeyword = () => {
        const kw = input.trim();
        if (kw && !keywords.includes(kw)) {
            setKeywords([...keywords, kw]);
            setInput('');
        }
    };

    const addKeyword = () => {
        submitKeyword();
        inputRef.current?.focus();
    };

    const onKeyDown = (e) => {
        if (e.key === 'Enter') addKeyword();
        if (e.key === 'Backspace' && input === '' && keywords.length) {
            setKeywords(keywords.slice(0, -1));
        }
    };

    const run = () => {
        // Internal value is "YYYY-MM-DDTHH:mm:ss" -> normalize to "YYYY-MM-DD HH:mm:ss".
        const norm = (v) => v ? v.replace('T', ' ') : '';
        onRun({year, startTime: norm(startTime), endTime: norm(endTime), level, keywords});
    };

    const openFmtModal = () => {
        setFmtInput(logFormat);
        setDateFmt('');
        setYearLocal(year);
        setShowFmtModal(true);
    };

    useEffect(() => {
        if (showFmtModal) {
            setTimeout(() => fmtInputRef.current?.focus(), 0);
        }
    }, [showFmtModal]);

    const confirmFmt = () => {
        setLogFormat(fmtInput.trim());
        if (yearLocal !== year) onYearChange(yearLocal);
        setShowFmtModal(false);
    };

    const selectDateFmt = (e) => {
        const v = e.target.value;
        setDateFmt(v);
        const item = DATE_FORMATS.find(d => d.label === v);
        if (item) setFmtInput(item.value);
    };

    return (
        <div className="filter-bar">
            <button
                className="icon-btn panel-toggle"
                title={panelCollapsed ? '展开文件列表' : '收起文件列表'}
                onClick={() => setPanelCollapsed(c => !c)}
            >
                {panelCollapsed ? '▸' : '◂'}
            </button>

            <div className="filter-tools">
                <button
                    className="btn ghost fmt-btn"
                    onClick={openFmtModal}
                    title="打开设置"
                >
                    设置
                </button>

                <div className="lvl-wrap">
                    <div className="lvl-select">
                        <select value={level} onChange={e => setLevel(e.target.value)}>
                            {LEVELS.map(l => (
                                <option key={l} value={l}>{l === '' ? '全部级别' : l}</option>
                            ))}
                        </select>
                        <span className="lvl-select-arrow">▾</span>
                    </div>
                </div>

                <div className="time-range">
                    <TimeField
                        value={startTime}
                        min={minTime}
                        max={maxTime}
                        onChange={setStartTime}
                        placeholder="开始时间"
                    />
                    <span className="tr-arrow">→</span>
                    <TimeField
                        value={endTime}
                        min={minTime}
                        max={maxTime}
                        onChange={setEndTime}
                        placeholder="结束时间"
                    />
                </div>

                <div className="kw-input-wrap">
                    {keywords.map(kw => (
                        <span className="kw-chip" key={kw}>
                            {kw}
                            <button
                                className="kw-x"
                                onClick={() => setKeywords(keywords.filter(x => x !== kw))}
                            >×</button>
                        </span>
                    ))}
                    <input
                        ref={inputRef}
                        className="kw-input"
                        value={input}
                        placeholder={keywords.length ? '输入后回车添加…' : '输入关键字回车添加（多个关键字需全部匹配）'}
                        onChange={e => setInput(e.target.value)}
                        onKeyDown={onKeyDown}
                        onBlur={submitKeyword}
                    />
                </div>

                <button className="btn primary run-btn" onClick={run} disabled={disabled || busy}>
                    {busy ? '过滤中…' : '开始过滤'}
                </button>
                {total > 0 && <span className="total-pill">{total} 条</span>}
            </div>

            {showFmtModal && (
                <div
                    className="modal-mask"
                    onMouseDown={e => {
                        if (e.target === e.currentTarget) setShowFmtModal(false);
                    }}
                >
                    <div className="modal modal-wide">
                        <div className="modal-head">
                            <span className="modal-title">设置</span>
                            <button className="icon-btn" title="关闭" onClick={() => setShowFmtModal(false)}>✕</button>
                        </div>
                        <div className="modal-body">
                            <div className="modal-field">
                                <label className="modal-label">日志格式</label>
                                <p className="modal-desc">
                                    输入 logback / log4j 风格日志格式。留空则自动识别时间/级别/线程/Logger/消息等列。修改后需重新加载文件生效。
                                </p>
                                {detectedFormats.length > 0 && (
                                    <div className="modal-detect">
                                        <span className="modal-detect-label">已自动识别格式：</span>
                                        <code className="modal-detect-fmt">{detectedFormats[0]}</code>
                                        {detectedFormats.length > 1 && <span className="modal-detect-more">（共 {detectedFormats.length} 个）</span>}
                                    </div>
                                )}
                                <input
                                    ref={fmtInputRef}
                                    className="modal-input"
                                    value={fmtInput}
                                    onChange={e => setFmtInput(e.target.value)}
                                    onKeyDown={e => e.stopPropagation()}
                                    onKeyUp={e => e.stopPropagation()}
                                    placeholder="如 %date %-5level [%thread] %logger - %m%n"
                                    autoFocus
                                />
                                <div className="modal-tokens">
                                    {['%date', '%level', '%thread', '%logger', '%msg', '%n'].map(t => (
                                        <button key={t} className="token-chip" onClick={() => setFmtInput(v => v + t)}>{t}</button>
                                    ))}
                                </div>
                            </div>

                            <div className="modal-field">
                                <label className="modal-label">日期格式</label>
                                <p className="modal-desc">
                                    选择日志中日期时间的常见格式，将用对应的模板填充上方"日志格式"。
                                </p>
                                <select
                                    className="modal-input date-fmt-select"
                                    value={dateFmt}
                                    onChange={selectDateFmt}
                                >
                                    <option value="">自动识别（不指定）</option>
                                    {DATE_FORMATS.map(d => (
                                        <option key={d.label} value={d.label}>{d.label}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="modal-field">
                                <label className="modal-label">日期年份</label>
                                <p className="modal-desc">
                                    日志时间戳不含年份时按此年份解析（默认当前年）。改年份后需重新加载文件生效。
                                </p>
                                <input
                                    type="number"
                                    className="year-input"
                                    value={yearLocal}
                                    min={2000}
                                    max={2100}
                                    onChange={e => setYearLocal(parseInt(e.target.value) || 2026)}
                                />
                            </div>
                        </div>
                        <div className="modal-foot">
                            <button className="btn ghost" onClick={() => setShowFmtModal(false)}>取消</button>
                            <button className="btn primary" onClick={confirmFmt}>确定</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default FilterBar;