import React, {useEffect, useRef, useState} from 'react';
import TextInputModal from './TextInputModal';

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

function fmtSize(bytes) {
    if (!bytes) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

function FilePanel({
    width, workingDir, files, selectedPaths, setSelectedPaths, loadedFiles,
    onRefresh, onPickDir, onPickFile, onLoad, onUnload,
    onLoadClipboard, onLoadText,
    year, logFormat, setLogFormat, detectedFormats, onYearChange,
}) {
    const [textOpen, setTextOpen] = useState(false);
    const [showFmtModal, setShowFmtModal] = useState(false);
    const [fmtInput, setFmtInput] = useState(logFormat);
    const [dateFmt, setDateFmt] = useState('');
    const [yearLocal, setYearLocal] = useState(year);
    const fmtInputRef = useRef(null);
    const toggle = (path) => {
        setSelectedPaths(prev => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path); else next.add(path);
            return next;
        });
    };
    const toggleAll = () => {
        if (files.length === 0) return;
        setSelectedPaths(prev =>
            prev.size === files.length ? new Set() : new Set(files.map(f => f.path))
        );
    };

    const loadedSet = new Set(loadedFiles.map(f => f.path));

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
        <aside className="file-panel" style={{width}}>
            <div className="panel-actions">
                <button className="btn ghost" onClick={onPickDir}>打开目录</button>
                <button className="btn ghost" onClick={onPickFile}>打开文件</button>
            </div>

            <div className="panel-actions">
                <button className="btn ghost" title="读取剪贴板中的日志文本" onClick={onLoadClipboard}>粘贴日志</button>
                <button className="btn ghost" title="手动输入或粘贴日志文本" onClick={() => setTextOpen(true)}>手动输入</button>
            </div>

            <div className="panel-sep" />

            <div className="panel-actions">
                <button className="btn ghost" title="打开设置" onClick={openFmtModal}>设置</button>
            </div>

            {textOpen && (
                <TextInputModal
                    onClose={() => setTextOpen(false)}
                    onSubmit={onLoadText}
                />
            )}

            <div className="panel-head">
                <span className="panel-title">文件列表</span>
                <button className="icon-btn" title="刷新目录" onClick={() => onRefresh(workingDir, false)}>⟳</button>
            </div>

            <div className="dir-row" title={workingDir || '未选择目录'}>
                <span className="dir-icon">▸</span>
                <span className="dir-path">{workingDir || '点击上方"打开目录"选择工作目录'}</span>
            </div>

            <div className="file-toolbar">
                <button className="btn small" onClick={toggleAll}>
                    {selectedPaths.size === files.length && files.length > 0 ? '取消全选' : '全选'}
                </button>
                <button className="btn small primary" onClick={onLoad} disabled={selectedPaths.size === 0}>
                    加载选中 ({selectedPaths.size})
                </button>
            </div>

            <div className="file-list">
                {files.length === 0 && (
                    <div className="empty-tip">目录中暂无日志文件</div>
                )}
                {files.map(f => {
                    const sel = selectedPaths.has(f.path);
                    const loaded = loadedSet.has(f.path);
                    return (
                        <div
                            key={f.path}
                            className={`file-item ${sel ? 'selected' : ''} ${loaded ? 'loaded' : ''}`}
                            onClick={() => toggle(f.path)}
                        >
                            <span className="check">{sel ? '☑' : '☐'}</span>
                            <span className="file-name" title={f.path}>{f.name}</span>
                            <span className="file-size">{fmtSize(f.size)}</span>
                            {loaded && <span className="file-loaded">●</span>}
                        </div>
                    );
                })}
            </div>

            <div className="panel-foot">
                <div className="foot-label">已加载</div>
                <div className="loaded-list">
                    {loadedFiles.length === 0 ? (
                        <span className="muted">未加载文件</span>
                    ) : (
                        loadedFiles.map(f => (
                            <div className="loaded-chip" key={f.path} title={f.path}>
                                <span>{f.name}</span>
                                <span className="chip-size">{fmtSize(f.size)}</span>
                            </div>
                        ))
                    )}
                </div>
                <button className="btn small danger" onClick={onUnload} disabled={loadedFiles.length === 0}>
                    全部卸载
                </button>
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
        </aside>
    );
}

export default FilePanel;