import React from 'react';

function fmtSize(bytes) {
    if (!bytes) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0, n = bytes;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return n.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

function FilePanel({
    width, workingDir, files, selectedPaths, setSelectedPaths, loadedFiles,
    onRefresh, onPickDir, onPickFile, onLoad, onUnload, year, onYearChange,
}) {
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

    return (
        <aside className="file-panel" style={{width}}>
            <div className="panel-actions">
                <button className="btn ghost" onClick={onPickDir}>打开目录</button>
                <button className="btn ghost" onClick={onPickFile}>打开文件</button>
            </div>

            <div className="panel-head">
                <span className="panel-title">文件列表</span>
                <button className="icon-btn" title="刷新目录" onClick={() => onRefresh(workingDir, false)}>⟳</button>
            </div>

            <div className="dir-row" title={workingDir || '未选择目录'}>
                <span className="dir-icon">▸</span>
                <span className="dir-path">{workingDir || '点击上方"打开目录"选择工作目录'}</span>
            </div>

            <div className="year-row">
                <label>日志年份</label>
                <input
                    type="number"
                    className="year-input"
                    value={year}
                    min={2000}
                    max={2100}
                    onChange={e => onYearChange(parseInt(e.target.value) || 2026)}
                />
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
        </aside>
    );
}

export default FilePanel;