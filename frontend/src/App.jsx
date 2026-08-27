import React, {useCallback, useEffect, useRef, useState} from 'react';
import './App.css';
import FilePanel from './components/FilePanel';
import FilterBar from './components/FilterBar';
import ResultList from './components/ResultList';
import DetailPane from './components/DetailPane';
import CompareView from './components/CompareView';
import StatusBar from './components/StatusBar';
import {Export, Filter, GetDefaultYear, GetDetectedFormats, GetLoadedFiles, GetPage, GetWorkingDir, ListLogFiles, LoadConfig, LoadFiles, LoadText, PickDirectory, PickFile, SaveConfig, UnloadAll, ClipboardGetText} from './Dept';

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

function App() {
    const [year, setYear] = useState(2026);
    const [workingDir, setWorkingDir] = useState('');
    const [files, setFiles] = useState([]);
    const [selectedPaths, setSelectedPaths] = useState(new Set());
    const [loadedFiles, setLoadedFiles] = useState([]);
    const [busy, setBusy] = useState(false);
    const [statusMsg, setStatusMsg] = useState('就绪');
    const [logFormat, setLogFormat] = useState('');
    const [detectedFormats, setDetectedFormats] = useState([]);
    const [configReady, setConfigReady] = useState(false); // true once saved config is applied

    // filter + result state
    const [filter, setFilter] = useState({
        year,
        startTime: '',
        endTime: '',
        level: '',
        keywords: [],
    });
    const [total, setTotal] = useState(0);
    const [physicalLines, setPhysicalLines] = useState(0);
    const [foldedLines, setFoldedLines] = useState(0);
    const [entries, setEntries] = useState([]);
    const [filtering, setFiltering] = useState(false);
    const [selected, setSelected] = useState(null);
    const lastResRef = useRef(null); // not used; page pulled via backend

    // log comparison state
    const [compareOpen, setCompareOpen] = useState(false);          // fullscreen compare workspace
    const [compareQueue, setCompareQueue] = useState([]);           // queued LogEntry objects
    const [compareLeftKey, setCompareLeftKey] = useState(null);     // key placed on the left
    const [compareRightKey, setCompareRightKey] = useState(null);   // key placed on the right

    // panel collapse + width
    const [panelCollapsed, setPanelCollapsed] = useState(false);
    const [panelWidth, setPanelWidth] = useState(300);
    const dividerRef = useRef(null);
    const dragState = useRef(null);

    // detail pane collapse + height
    const [detailCollapsed, setDetailCollapsed] = useState(true);
    const [detailHeight, setDetailHeight] = useState(220);
    const detailDrag = useRef(null);

    // result column visibility
    const [hiddenCols, setHiddenCols] = useState(new Set());

    const startDetailDrag = useCallback((e) => {
        detailDrag.current = { startY: e.clientY, startH: detailHeight };
        document.body.style.cursor = 'row-resize';
        document.body.style.userSelect = 'none';
    }, [detailHeight]);

    useEffect(() => {
        const onMove = (e) => {
            if (!detailDrag.current) return;
            const dy = e.clientY - detailDrag.current.startY;
            const h = Math.min(480, Math.max(120, detailDrag.current.startH - dy));
            setDetailHeight(h);
        };
        const onUp = () => {
            detailDrag.current = null;
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

    const startDrag = useCallback((e) => {
        dragState.current = { startX: e.clientX, startW: panelWidth };
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    }, [panelWidth]);

    useEffect(() => {
        const onMove = (e) => {
            if (!dragState.current) return;
            const dx = e.clientX - dragState.current.startX;
            const w = Math.min(520, Math.max(200, dragState.current.startW + dx));
            setPanelWidth(w);
        };
        const onUp = () => {
            dragState.current = null;
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

    const refreshDir = useCallback(async (dir, rec) => {
        if (!dir) return;
        const list = await ListLogFiles(dir, rec);
        setFiles(list || []);
        setWorkingDir(dir);
    }, []);

    const refreshDetected = useCallback(async () => {
        try {
            const df = await GetDetectedFormats();
            setDetectedFormats(df || []);
        } catch {
            setDetectedFormats([]);
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            let cfg = null;
            let defaultYear = 2026;
            try { cfg = await LoadConfig(); } catch { cfg = null; }
            try { defaultYear = await GetDefaultYear(); } catch { /* ignore */ }
            if (cancelled) return;
            const cfgYear = (cfg && cfg.year) ? cfg.year : defaultYear;
            setYear(cfgYear);
            setLogFormat((cfg && cfg.logFormat) || '');
            const savedDir = (cfg && cfg.workingDir) || '';
            if (savedDir) {
                refreshDir(savedDir, false);
            } else {
                GetWorkingDir().then(dir => { if (dir) refreshDir(dir, false); });
            }
            setConfigReady(true);
        })();
        return () => { cancelled = true; };
    }, [refreshDir]);

    // Persist the UI configuration to the OS temp dir whenever it changes, but
    // only after the saved config has been applied on startup.
    useEffect(() => {
        if (!configReady) return;
        SaveConfig({
            year,
            logFormat,
            workingDir,
        });
    }, [configReady, year, logFormat, workingDir]);

    const handlePickDir = async () => {
        const dir = await PickDirectory();
        if (dir) await refreshDir(dir, false);
    };

    const handlePickFile = async () => {
        const file = await PickFile();
        if (!file) return;
        setBusy(true);
        setStatusMsg('正在加载文件…');
        try {
            await LoadFiles([file], year, logFormat);
            const current = await GetLoadedFiles();
            setLoadedFiles(current || []);
            await refreshDetected();
            setStatusMsg(`已加载 ${current.length} 个文件`);
            if (current.length > 0) await runFilter({...filter, year});
        } finally {
            setBusy(false);
        }
    };

    const handleLoadSelected = async () => {
        const paths = Array.from(selectedPaths);
        if (paths.length === 0) {
            setStatusMsg('请先选择要加载的日志文件');
            return;
        }
        setBusy(true);
        setStatusMsg(`正在加载 ${paths.length} 个文件…`);
        try {
            await LoadFiles(paths, year, logFormat);
            const current = await GetLoadedFiles();
            setLoadedFiles(current || []);
            await refreshDetected();
            setStatusMsg(`已加载 ${current.length} 个文件`);
            if (current.length > 0) await runFilter({...filter, year});
        } finally {
            setBusy(false);
        }
    };

    const handleUnload = async () => {
        await UnloadAll();
        setLoadedFiles([]);
        setEntries([]);
        setTotal(0);
        setDetectedFormats([]);
        setStatusMsg('已清空');
    };

    // Load log text pasted from the system clipboard.
    const handleLoadClipboard = async () => {
        let text = '';
        try {
            text = await ClipboardGetText();
        } catch {
            text = '';
        }
        if (!text || !text.trim()) {
            setStatusMsg('剪贴板内容为空');
            return;
        }
        await handleLoadText('剪切板', text);
    };

    // Load log text entered manually (via the text-input dialog).
    const handleLoadText = async (label, text) => {
        if (!text || !text.trim()) {
            setStatusMsg('输入内容为空');
            return;
        }
        setBusy(true);
        setStatusMsg('正在解析文本日志…');
        try {
            await LoadText(label, text.trim(), year, logFormat);
            const current = await GetLoadedFiles();
            setLoadedFiles(current || []);
            await refreshDetected();
            setStatusMsg(`已加载 ${current.length} 个文件`);
            if (current.length > 0) await runFilter({...filter, year});
        } finally {
            setBusy(false);
        }
    };

    const runFilter = async (f) => {
        setFiltering(true);
        setStatusMsg('正在过滤…');
        try {
            const stats = await Filter(f);
            const phys = stats.physicalLines || 0;
            const fold = stats.foldedLines || 0;
            setTotal(stats.total);
            setPhysicalLines(phys);
            setFoldedLines(fold);
            setEntries([]);
            setSelected(null);
            let page = [];
            if (stats.total > 0) {
                page = await GetPage(0, 200);
            }
            setEntries(page || []);
            clearCompare();
            setStatusMsg(`匹配 ${stats.total} 条记录（物理行 ${phys}，折叠行 ${fold}） · 已加载 ${stats.filesLoaded} 个文件 · ${(stats.totalBytes / 1024 / 1024).toFixed(1)} MB`);
        } finally {
            setFiltering(false);
        }
    };

    const handleRunFilter = async (f) => {
        setFilter(f);
        await runFilter(f);
    };

    // Export the current filter results with exactly the columns the list shows.
    const handleExport = async (cols) => {
        if (loadedFiles.length === 0) {
            setStatusMsg('没有已加载的数据');
            return;
        }
        const formatActive = !!logFormat.trim() || detectedFormats.length > 0;
        setBusy(true);
        setStatusMsg('正在导出…');
        try {
            const info = await Export(formatActive, cols);
            if (info && info.path) {
                setStatusMsg(`已导出 ${info.name}`);
            } else {
                setStatusMsg('已取消导出');
            }
        } catch {
            setStatusMsg('导出失败');
        } finally {
            setBusy(false);
        }
    };

    // Double-click on a result column value adds that value as a keyword and
    // re-runs. Message content (and any other long value) is excluded via a
    // length cap so it cannot become a filter condition by accident.
    const MAX_FILTER_VALUE_LEN = 20;
    const handleDoubleClickCell = async (value) => {
        const v = (value || '').trim();
        if (!v) return;
        if (v.length > MAX_FILTER_VALUE_LEN) {
            setStatusMsg(`内容过长（${v.length} 字符），超过 ${MAX_FILTER_VALUE_LEN} 字符的内容不能加入过滤条件`);
            return;
        }
        const kws = filter.keywords.includes(v) ? filter.keywords : [...filter.keywords, v];
        await handleRunFilter({...filter, keywords: kws});
    };

    const loadMore = useCallback(async () => {
        const offset = entries.length;
        const page = await GetPage(offset, 200);
        if (page && page.length) {
            setEntries(prev => {
                const seen = new Set(prev.map(e => e.lineNo + '|' + e.fileName));
                const fresh = page.filter(e => !seen.has(e.lineNo + '|' + e.fileName));
                return [...prev, ...fresh];
            });
        }
    }, [entries.length]);

    const entryKey = (e) => e.lineNo + '|' + e.fileName;

    const deleteRow = (e) => {
        const k = entryKey(e);
        setEntries(prev => prev.filter(x => entryKey(x) !== k));
        setSelected(sel => (sel && entryKey(sel) === k ? null : sel));
        setCompareQueue(prev => prev.filter(x => entryKey(x) !== k));
        setCompareLeftKey(lk => (lk === k ? null : lk));
        setCompareRightKey(rk => (rk === k ? null : rk));
        setStatusMsg(`已删除记录 ${e.lineNo}`);
    };

    const toggleComparePanel = () => setCompareOpen(o => !o);

    const formatActive = !!logFormat.trim() || detectedFormats.length > 0;
    const multi = loadedFiles.length > 1;
    const headerCols = (formatActive ? FORMAT_COLS : PLAIN_COLS).filter(c => c.id !== 'file' || multi);
    const exportCols = headerCols.filter(c => !hiddenCols.has(c.id)).map(c => c.id);

    const toggleCompare = (e) => {
        const k = entryKey(e);
        const inQueue = compareQueue.some(x => entryKey(x) === k);
        if (inQueue) {
            setCompareQueue(prev => prev.filter(x => entryKey(x) !== k));
            setCompareLeftKey(lk => (lk === k ? null : lk));
            setCompareRightKey(rk => (rk === k ? null : rk));
        } else {
            setCompareQueue(prev => [...prev, e]);
        }
        // The compare panel (with the queue list) only opens via the "对比"
        // button; right-click adding just silently enqueues the row.
    };
    const removeCompare = (k) => {
        setCompareQueue(prev => prev.filter(x => entryKey(x) !== k));
        setCompareLeftKey(lk => (lk === k ? null : lk));
        setCompareRightKey(rk => (rk === k ? null : rk));
    };
    const placeLeft = (k) => {
        if (compareRightKey === k) setCompareRightKey(null);
        setCompareLeftKey(k);
    };
    const placeRight = (k) => {
        if (compareLeftKey === k) setCompareLeftKey(null);
        setCompareRightKey(k);
    };
    const clearCompare = () => {
        setCompareQueue([]);
        setCompareLeftKey(null);
        setCompareRightKey(null);
    };

    return (
        <div className="app">
            <div className="app-body">
                {!panelCollapsed && (
                    <FilePanel
                        width={panelWidth}
                        workingDir={workingDir}
                        files={files}
                        selectedPaths={selectedPaths}
                        setSelectedPaths={setSelectedPaths}
                        loadedFiles={loadedFiles}
                        onRefresh={refreshDir}
                        onPickDir={handlePickDir}
                        onPickFile={handlePickFile}
                        onLoad={handleLoadSelected}
                        onLoadClipboard={handleLoadClipboard}
                        onLoadText={text => handleLoadText('文本输入', text)}
                        onUnload={handleUnload}
                        year={year}
                        logFormat={logFormat}
                        setLogFormat={setLogFormat}
                        detectedFormats={detectedFormats}
                        onYearChange={setYear}
                    />
                )}

                {!panelCollapsed && (
                    <div
                        className="panel-divider"
                        ref={dividerRef}
                        onMouseDown={startDrag}
                        title="拖动调整宽度"
                    />
                )}

                <main className="main">
                    <FilterBar
                        year={year}
                        filter={filter}
                        onRun={handleRunFilter}
                        busy={filtering}
                        disabled={loadedFiles.length === 0}
                        loadedCount={loadedFiles.length}
                        panelCollapsed={panelCollapsed}
                        setPanelCollapsed={setPanelCollapsed}
                        compareOpen={compareOpen}
                        onToggleComparePanel={toggleComparePanel}
                        onExport={handleExport}
                        exportCols={exportCols}
                        hasResults={total > 0}
                    />
                    <ResultList
                        entries={entries}
                        total={total}
                        selected={selected}
                        setSelected={setSelected}
                        loadMore={loadMore}
                        busy={busy || filtering}
                        keywords={filter.keywords}
                        formatActive={formatActive}
                        hiddenCols={hiddenCols}
                        setHiddenCols={setHiddenCols}
                        headerCols={headerCols}
                        onDoubleClickCell={handleDoubleClickCell}
                        compareQueue={compareQueue}
                        compareLeftKey={compareLeftKey}
                        compareRightKey={compareRightKey}
                        onToggleCompare={toggleCompare}
                        onDeleteRow={deleteRow}
                    />

                    {!detailCollapsed && (
                        <div
                            className="detail-divider"
                            onMouseDown={startDetailDrag}
                            title="拖动调整高度"
                        />
                    )}

                    {detailCollapsed ? (
                        <button
                            className="detail-restore"
                            title="展开日志详情"
                            onClick={() => setDetailCollapsed(false)}
                        >
                            ▧
                        </button>
                    ) : (
                        <DetailPane
                            entry={selected}
                            height={detailHeight}
                            onCollapse={() => setDetailCollapsed(true)}
                        />
                    )}
                </main>
            </div>

            <StatusBar status={statusMsg} loadedRecords={entries.length}/>

            {compareOpen && (
                <CompareView
                    queue={compareQueue}
                    leftKey={compareLeftKey}
                    rightKey={compareRightKey}
                    entryKey={entryKey}
                    onClose={() => setCompareOpen(false)}
                    onRemove={removeCompare}
                    onPlaceLeft={placeLeft}
                    onPlaceRight={placeRight}
                    onClear={clearCompare}
                />
            )}
        </div>
    );
}

export default App;
