// webApp.js — 浏览器端 App 实现（等价 backend/app.go 的 IPC 方法）
// 全部为 async，返回结构与 wails 绑定一致。

import {compileRecordPattern} from './pattern.js';
import {parseLogText, ParsedLog} from './parser.js';
import {runFilter, getPage, getTimeRange, buildExportCsv} from './filter.js';

// ---- 内部状态 ----
let dirSeq = 0;
let webSeq = 0;
let textSeq = 0;
const dirHandles = new Map();  // dir:N -> {type:'fds'|'flat', handle, files:[{name,size,lastModified,key}]}
const fileRefs = new Map();    // web:N -> {name, size, lastModified, handle, file}
let files = [];                // ParsedLog[]
let loadedKeys = new Set();    // 去重键
let lastRes = null;            // {total, items:[{file,rec}]}
let lastDirId = '';

const CONFIG_KEY = 'loganalysis-config';

const isLogExt = (name) => {
    const e = (name.split('.').pop() || '').toLowerCase();
    return e === 'log' || e === 'txt' || e === 'out';
};

function pad2(n) { return String(n).padStart(2, '0'); }

async function readConfigFile() {
    try {
        const raw = localStorage.getItem(CONFIG_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

async function writeConfigFile(cfg) {
    try {
        localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
    } catch {
        // ignore quota / unavailable
    }
}

// ---- dialogs / file discovery ----

export async function PickDirectory() {
    const picker = window.showDirectoryPicker;
    if (picker) {
        const handle = await picker({mode: 'read'});
        const id = 'dir:' + (++dirSeq);
        dirHandles.set(id, {type: 'fds', handle});
        lastDirId = id;
        return id;
    }
    // Fallback: flat folder via webkitdirectory input.
    const filesArr = await pickViaInput(true);
    if (!filesArr || filesArr.length === 0) return '';
    const id = 'dir:' + (++dirSeq);
    dirHandles.set(id, {type: 'flat', files: filesArr.map(toRef)});
    lastDirId = id;
    return id;
}

export async function PickFile() {
    const picker = window.showOpenFilePicker;
    if (picker) {
        const handles = await picker({multiple: false});
        if (!handles || handles.length === 0) return '';
        return registerFileHandle(handles[0]);
    }
    const filesArr = await pickViaInput(false);
    if (!filesArr || filesArr.length === 0) return '';
    return registerFileObject(filesArr[0]);
}

function toRef(f) {
    return {name: f.name, size: f.size, lastModified: f.lastModified, key: `${f.name}:${f.size}:${f.lastModified}`};
}

function pickViaInput(directory) {
    return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        if (directory) input.setAttribute('webkitdirectory', '');
        else input.setAttribute('multiple', '');
        input.style.display = 'none';
        document.body.appendChild(input);
        input.addEventListener('change', () => {
            const list = Array.from(input.files || []);
            document.body.removeChild(input);
            resolve(list);
        });
        input.addEventListener('cancel', () => {
            document.body.removeChild(input);
            resolve([]);
        });
        input.click();
    });
}

function registerFileObject(f) {
    const id = 'web:' + (++webSeq);
    fileRefs.set(id, {name: f.name, size: f.size, lastModified: f.lastModified, file: f});
    return id;
}

function registerFileHandle(handle) {
    const id = 'web:' + (++webSeq);
    const f = {name: handle.name};
    fileRefs.set(id, {name: handle.name, size: 0, lastModified: 0, handle});
    return id;
}

async function fileSizeOf(ref) {
    if (ref.file) return ref.file.size;
    if (ref.handle) {
        const file = await ref.handle.getFile();
        ref.file = file;
        return file.size;
    }
    return 0;
}

export async function ListLogFiles(dirId, recursive) {
    const d = dirHandles.get(dirId);
    if (!d) return [];
    const out = [];
    const walk = async (handle, outArr) => {
        if (handle && handle.kind === 'directory') {
            for await (const entry of handle.values()) {
                if (entry.kind === 'directory') {
                    if (recursive) await walk(entry, outArr);
                } else if (isLogExt(entry.name)) {
                    outArr.push(entry);
                }
            }
        } else if (handle && handle.kind === 'file' && isLogExt(handle.name)) {
            outArr.push(handle);
        }
    };

    if (d.type === 'fds') {
        await walk(d.handle, out);
    } else {
        // flat fallback
        for (const f of d.files) {
            if (isLogExt(f.name)) {
                const id = 'web:' + (++webSeq);
                fileRefs.set(id, f);
                out.push({id});
            }
        }
    }

    const list = [];
    for (const h of out) {
        let size = 0;
        if (h.id) {
            const ref = fileRefs.get(h.id);
            size = ref ? ref.size : 0;
            list.push({name: ref ? ref.name : '', path: h.id, size});
        } else {
            try {
                const file = await h.getFile();
                const id = 'web:' + (++webSeq);
                fileRefs.set(id, {name: file.name, size: file.size, lastModified: file.lastModified, file});
                list.push({name: file.name, path: id, size: file.size});
            } catch {
                // skip unreadable
            }
        }
    }
    list.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return list;
}

async function resolveFile(id) {
    const ref = fileRefs.get(id);
    if (!ref) return null;
    if (ref.file) return ref.file;
    if (ref.handle) {
        const file = await ref.handle.getFile();
        ref.file = file;
        return file;
    }
    return null;
}

async function sha256Hex(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function LoadFiles(paths, year, logFormat) {
    const format = compileRecordPattern(String(logFormat || '').trim());
    const loaded = [];
    for (const rawP of paths || []) {
        const p = String(rawP || '').trim();
        if (!p) continue;
        const file = await resolveFile(p);
        if (!file) continue;
        const dedupeKey = `file:${file.name}:${file.size}:${file.lastModified || 0}`;
        if (loadedKeys.has(dedupeKey)) continue;
        const content = await file.text();
        const pl = await parseLogText(content, file.size, p, file.name, year, format);
        pl.dedupeKey = dedupeKey;
        files.push(pl);
        loadedKeys.add(dedupeKey);
        loaded.push({name: file.name, path: p, size: file.size});
    }
    lastRes = null;
    return loaded;
}

export async function LoadText(label, text, year, logFormat) {
    text = String(text || '').trim();
    if (text === '') return [];
    const key = await sha256Hex(text);
    if (loadedKeys.has('text:' + key)) return [];
    textSeq++;
    const name = `${label} ${textSeq}`;
    const format = compileRecordPattern(String(logFormat || '').trim());
    const size = new TextEncoder().encode(text).length;
    const pl = await parseLogText(text, size, name, name, year, format);
    pl.dedupeKey = 'text:' + key;
    files.push(pl);
    loadedKeys.add('text:' + key);
    lastRes = null;
    return [{name, path: name, size}];
}

export async function GetLoadedFiles() {
    return files.map((pl) => ({name: pl.name, path: pl.path, size: pl.size}));
}

export async function GetDetectedFormats() {
    const out = [];
    for (const pl of files) {
        if (!pl.autoDetected) continue;
        if (pl.formatStr) out.push(pl.formatStr);
        if (pl.altFormatStr) out.push(pl.altFormatStr);
    }
    return out;
}

export async function UnloadAll() {
    files = [];
    loadedKeys = new Set();
    lastRes = null;
}

export async function Filter(params) {
    if (files.length === 0) {
        lastRes = {total: 0, items: []};
        return {total: 0, filesLoaded: 0, totalBytes: 0, physicalLines: 0, foldedLines: 0, message: '没有已加载的文件'};
    }
    const res = runFilter(files, params);
    lastRes = {total: res.total, items: res.items};
    return {
        total: res.total,
        filesLoaded: res.filesLoaded,
        totalBytes: res.totalBytes,
        physicalLines: res.physicalLines,
        foldedLines: res.foldedLines,
    };
}

export async function GetPage(offset, limit) {
    if (lastRes === null || files.length === 0) return null;
    return getPage(files, lastRes.items, offset, limit);
}

export async function GetTimeRange() {
    return getTimeRange(files);
}

export async function Export(format, cols) {
    if (lastRes === null || files.length === 0) return {};
    const csv = buildExportCsv(cols, !!format, lastRes.items, files);
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
    const name = `${stamp}.log`;
    const blob = new Blob(['\uFEFF' + csv], {type: 'text/csv;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return {name, path: name, size: blob.size};
}

export async function LoadConfig() {
    const cfg = await readConfigFile();
    if (!cfg) return {year: 0, logFormat: '', workingDir: ''};
    return cfg;
}

export async function SaveConfig(cfg) {
    await writeConfigFile({
        year: cfg.year || 0,
        logFormat: cfg.logFormat || '',
        workingDir: cfg.workingDir || '',
    });
}

export async function GetWorkingDir() {
    return lastDirId;
}

export async function GetDefaultYear() {
    return new Date().getFullYear();
}

export async function ClipboardGetText() {
    try {
        if (navigator.clipboard && navigator.clipboard.readText) {
            const t = await navigator.clipboard.readText();
            if (t) return t;
        }
    } catch {
        // fall through
    }
    try {
        const ta = document.createElement('textarea');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        document.execCommand('paste');
        const v = ta.value;
        document.body.removeChild(ta);
        return v;
    } catch {
        return '';
    }
}
