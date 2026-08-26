# LogAnalysis 前端 Web 化改造方案（Go 后端 → JS 移植 + Dept.js 门面）

> 本文档为实施计划，末节为**修改进度跟踪表**，随实施实时更新。
> 创建日期：2026-08-26

## 1. 背景与目标

Wails v2 桌面应用（Go 后端 + React 19 前端）现有 IPC 能力全部来自 Go。目标：

1. 将 `backend/app.go`、`parser.go`、`pattern.go`、`detect.go`、`filter.go` 的核心功能用 JS 重新实现一遍。
2. 新建 `frontend/src/Dept.js` 作为统一后端门面，`App.jsx`（及 `FilterBar.jsx`）改为只从 `Dept.js` 导入。
3. `Dept.js` 按构建方式二选一：
   - 桌面/开发构建（wails）：继续用 `frontend/wailsjs/go/main/App.js` + `frontend/wailsjs/runtime/runtime.js`（即 Go 实现）。
   - Web 构建（部署到 Cloudflare）：使用新写的 JS 实现。

已确认的两项决策：
- **浏览器文件访问**：File System Access API（Chrome/Edge）为主，`<input type=file>` 兜底（Firefox/Safari 降级）。
- **构建方式判定**：Vite `--mode web` + 运行时 `window.go` 双保险。

## 2. 架构总览

```
frontend/src/App.jsx ──────────────┐  原有两行 wailsjs import 删除
frontend/src/components/FilterBar.jsx ┐  改从 Dept 导入
                                     │
frontend/src/Dept.js  (门面，只做路由)
        │ 判断 import.meta.env.MODE==='web' 或 window.go 不存在
        ├─→ '../wailsjs/go/main/App'  +  '../wailsjs/runtime/runtime'   [桌面，Go]
        └─→ './dept/webApp'                                            [Web，JS]
                   │
frontend/src/dept/
   ├─ pattern.js  (移植 backend/pattern.go : logback 模式编译)
   ├─ date.js     (移植 parseDateFast / parsePatternUnix / 布局解析)
   ├─ detect.js   (移植 backend/detect.go : 自动识别 + 评分)
   ├─ parser.js   (移植 backend/parser.go : 分行/折叠/记录)
   ├─ filter.js   (移植 backend/filter.go : 过滤/分页/CSV)
   └─ webApp.js   (有状态 App 实现：目录句柄、加载、localStorage、下载)
```

## 3. 文件清单

### 新增（8 个）
| 文件 | 内容 |
|---|---|
| `docs/web-port-plan.md` | 本文档（方案 + 进度跟踪） |
| `frontend/src/Dept.js` | 门面，二选一路由 |
| `frontend/src/dept/pattern.js` | 模式编译 |
| `frontend/src/dept/date.js` | 日期解析 |
| `frontend/src/dept/detect.js` | 格式自动识别 |
| `frontend/src/dept/parser.js` | 日志解析管线 |
| `frontend/src/dept/filter.js` | 过滤、分页、CSV 导出构建 |
| `frontend/src/dept/webApp.js` | 浏览器端 App 状态与 API |

### 修改（4 个）
| 文件 | 改动 |
|---|---|
| `frontend/src/App.jsx` | 第 9–10 行改为 `import {…} from './Dept';` |
| `frontend/src/components/FilterBar.jsx` | 第 2 行 `GetTimeRange` 改 `from '../../Dept'` |
| `frontend/package.json` | 新增 `"build:web": "vite build --mode web"` |
| `frontend/vite.config.js` | outDir 按 mode 分支 |

> `frontend/dist/` 已在 `.gitignore`，Web 产物不会入库，与桌面 `backend/frontend/dist` 互不影响。

## 4. 详细修改过程

### 4.1 `frontend/src/Dept.js`（新增，门面）

```js
import * as wailsApp from '../wailsjs/go/main/App';
import {ClipboardGetText as wailsClipboardGetText} from '../wailsjs/runtime/runtime';
import * as webApp from './dept/webApp';

const isWeb =
    import.meta.env.MODE === 'web' ||
    (typeof window !== 'undefined' && !window.go?.main?.App);

const impl = isWeb ? webApp : {...wailsApp, ClipboardGetText: wailsClipboardGetText};

export const Export              = impl.Export;
export const Filter              = impl.Filter;
export const GetDefaultYear      = impl.GetDefaultYear;
export const GetDetectedFormats  = impl.GetDetectedFormats;
export const GetLoadedFiles      = impl.GetLoadedFiles;
export const GetPage             = impl.GetPage;
export const GetTimeRange        = impl.GetTimeRange;
export const GetWorkingDir       = impl.GetWorkingDir;
export const ListLogFiles        = impl.ListLogFiles;
export const LoadConfig          = impl.LoadConfig;
export const LoadFiles           = impl.LoadFiles;
export const LoadText            = impl.LoadText;
export const PickDirectory       = impl.PickDirectory;
export const PickFile            = impl.PickFile;
export const SaveConfig          = impl.SaveConfig;
export const UnloadAll           = impl.UnloadAll;
export const ClipboardGetText    = impl.ClipboardGetText;
```

- wails 绑定函数本身只引用 `window['go']…`，静态导入在纯浏览器下无害（仅调用时报错），web 构建无需动态 import。
- 调用方（App.jsx）看到的签名与返回结构完全一致（全部 Promise）。

### 4.2 `frontend/src/dept/pattern.js`（移植 `pattern.go`）

- 常量片段 `dateRe/levelRe/threadRe/loggerRe/msgRe/classRe/methodRe/fileRe/numRe/tokenRe/uuidRe` 原样照搬（Go RE2 与 JS 命名组语法兼容）。
- `conversionRegex(name)` → 返回 `[regexString, known]`，逻辑逐条对应（`%n`/`newline` 输出 `\s*` 且不算字段）。
- `litRegex(lit)`：空白 run 折叠为 `\s+`；字面量用转义函数。
- `logbackPattern(pattern)`：JS 版组装 `^` + 各片段 + `$`，最终 `new RegExp(src, 's')`（等价 Go `(?s)` 前缀）。
- `escapeRe(s)` 对应 `regexp.QuoteMeta`。
- `compileRecordPattern(pattern)` → 返回 `{ re, src, fields, index }`；`fields` 用 `re.source` 里是否含 `(?<name>` 探测，取值统一走 `match.groups`。

### 4.3 `frontend/src/dept/date.js`（移植日期解析）

- `daysInMonth(mo, y)`、`isOffsetTail(t)`：照搬。
- `parseDateFast(s, year) → {unix, ok}`：流程照搬（trim → T 换空格 → 剥 ±/Z 尾巴 → 切 date/time → 校验时分秒 → 拼日期），终值 `Math.floor(new Date(y, mo-1, d, h, mi, ss, 0).getTime() / 1000)`（等价 Go `time.Date(…, time.Local).Unix()`）。
- `parsePatternUnix(s, year)`：先走 `parseDateFast`，失败则布局解析器。
- `parseLayout(layout, s, year)`：把 `2006/01/02/15/04/05/Jan` 布局转成正则捕获组解析（月份支持 `Jan…Dec`），`01-02` 前缀布局缺少年份时套用 `year`。

### 4.4 `frontend/src/dept/detect.js`（移植 `detect.go`）

- `autoDetectPatterns` 数组（约 50 条）原样照搬；`compiledAutoPatterns` 用 `pattern.js` 编译并去重（按 `re.source`）。
- `isContinuationLine(line)`：`/^(?:\s|Caused by:|Suppressed:|\.\.\.\s*\d+\s*more\b)/`。
- `validLevel` / `validThread` / `hasBracket`：逐条照搬。
- `scorePattern(rp, lines, year)`：字段校验用 `m.groups.date/level/thread/logger/msg`，数值系数完全一致：
  - 匹配率 < 0.5 → `matchRate*0.3`；≥0.5 后：date +0.06/-0.2、level +0.06/-0.2、thread +0.06/-0.35、logger +0.05/-0.15、msg 吞内容 -0.3、字段数 `+0.015*min(5,nf)`。
- `detectFormats(content, year)`：从字符串内容抽样（0、len/3、2len/3，len>8KB 才多窗口），返回主格式 + 可选次格式（残差行评分 ≥0.8）。

### 4.5 `frontend/src/dept/parser.js`（移植 `parser.go`）

核心数据结构（JS 版）：
```js
class ParsedLog {
  constructor() {
    this.path = ''; this.name = ''; this.size = 0; this.content = '';
    this.totalLines = 0; this.records = [];        // RecordRef[]
    this.format = null; this.altFormat = null;
    this.formatStr = ''; this.altFormatStr = ''; this.autoDetected = false;
    this.dedupeKey = '';
  }
}
// RecordRef: {offset, length, lineNo, hasTime, time, level, logger, thread, msg, unix}
```

- `parseLogText(content, size, path, year, format)`（async）：
  1. 若 `format` 为空 → `detectFormats` 取主/次格式并置 `autoDetected`。
  2. 顺序扫描：`content.indexOf('\n', pos)` 找行尾；`raw = content.slice(pos, nl<0? n : nl+1)`（含换行符，与 Go `ReadBytes` 一致）；`lineNo` 逐行递增；
  3. 每 5000 行 `await new Promise(r => setTimeout(r))` 让出主线程，避免 UI 冻结。
  4. `groupRecords(all)` 折叠续行：`cur.length = (ln.offset + ln.length) - cur.offset`（字符偏移等价）。
  5. `totalLines = 物理行数`。
- `parseLine` / `parseLineBasic` / `parseWithFormat`：逻辑照搬；`parseWithFormat` 用 `line.match(re)`，命名组经 `m.groups` 读 `date/level/thread/logger/msg`。
- `lineSpans()`：`records[i+1].lineNo - records[i].lineNo`，最后一条 `totalLines - lineNo + 1`。
- `readRecord(pl, rec)`：`pl.content.slice(rec.offset, rec.offset + rec.length)`。

> 偏移空间从 Go 的**字节**改为 JS 字符串的**字符**。对含中文/多字节 UTF-8 的日志，两者数值不同，但只要全程一致即可（Text 切片、过滤切片都用同一套字符偏移）。

### 4.6 `frontend/src/dept/filter.js`（移植 `filter.go`）

- `parseDT(year, s) → {unix, ok}`：支持 `01-02 15:04:05 / 01-02 15:04 / 15:04:05 / 15:04 / 2006-01-02 15:04:05 / 2006-01-02 15:04`，`01-02` 前缀套用 year（复用 `date.js` 的 `parseLayout`）。
- `filterLog(pl, params)`：
  - 时间区间用 `unix` 比较；level 大写精确匹配；关键字全转小写、须**全部**命中（AND）——`pl.content.slice(off, off+len).toLowerCase().includes(kw)`（JS `toLowerCase` 为 Unicode 语义，优于 Go 的 ASCII `bytes.ToLower`）。
  - 返回匹配 record 下标数组。
- `buildEntry(pl, rec, fileName)` → `LogEntry{lineNo, time, level, logger, thread, msg, unix, hasTime, text, fileName}`；单文件时 `fileName=''`（与 Go `GetPage` 的 `"fileName":""` 一致，保证 `lineNo|fileName` 键格式一致）。
- `buildExportCsv(cols, format, items, files)`：表头 label 映射（`行号/文件/时间/级别/线程/Logger/消息|内容`），行数据同 `GetPage` 取值逻辑，CSV 逗号/引号/换行转义。

### 4.7 `frontend/src/dept/webApp.js`（有状态 App，全部 async）

内部状态：
```js
const dirHandles = new Map();  // dir:N -> {type:'fds'|'flat', handle|files}
const fileRefs   = new Map();  // web:N -> {name, size, lastModified, handle|file}
let files = [];                // ParsedLog[]
let loadedKeys = new Set();    // 去重键（文件身份 或 text:sha256）
let lastRes = null;            // {total, items:[{file,rec}]}
let textSeq = 0;
let lastDirId = '';
```

API 实现（签名与 wails 一致）：
| 方法 | Web 实现 |
|---|---|
| `ListLogFiles(dirId, rec)` | 取句柄 → `handle.entries()` 异步遍历，过滤 `.log/.txt/.out`，rec 时递归子目录；为每个文件登记 `fileRefs`；按名忽略大小写排序 |
| `PickDirectory()` | 有 `showDirectoryPicker` → 登记 `dir:N` 返回 id；否则 `<input webkitdirectory multiple>` 收集文件当"目录"（flat 型） |
| `PickFile()` | `showOpenFilePicker()` 或 `<input type=file>`，登记 `web:N`，返回 id |
| `LoadFiles(paths, year, logFormat)` | 解析 id → `File` → `file.text()` → `parseLogText`；按文件身份（name+size+lastModified）去重；返回 `FileInfo[]` |
| `LoadText(label, text, year, logFormat)` | `crypto.subtle` SHA-256 十六进制去重；`TextEncoder` 长度当 size；合成路径 `'${label} ${++textSeq}'` |
| `GetLoadedFiles()` | 返回 `FileInfo[]` |
| `GetDetectedFormats()` | 遍历 `files` 中 `autoDetected` 的 `formatStr`/`altFormatStr` |
| `UnloadAll()` | 清空 files/loadedKeys/lastRes |
| `Filter(params)` | 遍历 files → `filterLog`，统计 `total/totalBytes/physicalLines/foldedLines/filesLoaded`，存 `lastRes` |
| `GetPage(offset, limit)` | 从 `lastRes.items` 切片 → `buildEntry`；`limit<=0` 默认 100 |
| `GetTimeRange()` | 遍历 records 首/末 `hasTime` 记录的 unix → 本地时区 `YYYY-MM-DD HH:mm:ss` |
| `Export(format, cols)` | `buildExportCsv` → 前置 `\uFEFF`（BOM）→ `Blob` → `<a download>` 触发下载 → 返回 `{name, path: name, size}`（App.jsx 只读 `info.path`/`info.name`，行为一致） |
| `LoadConfig()` / `SaveConfig(cfg)` | `localStorage['loganalysis-config']`；Web 不恢复 `workingDir`（跨会话目录句柄无效） |
| `GetWorkingDir()` | 返回最近一次 `dir:N` id（或 ''） |
| `GetDefaultYear()` | `new Date().getFullYear()` |
| `ClipboardGetText()` | `navigator.clipboard.readText()`；失败降级隐藏 textarea + `document.execCommand('paste')` |

### 4.8 `frontend/src/App.jsx`（修改）

第 9–10 行：
```jsx
// 删除：
import {Export, …, UnloadAll} from '../wailsjs/go/main/App';
import {ClipboardGetText} from '../wailsjs/runtime/runtime';
// 替换为：
import {Export, Filter, GetDefaultYear, GetDetectedFormats, GetLoadedFiles,
        GetPage, GetWorkingDir, ListLogFiles, LoadConfig, LoadFiles,
        LoadText, PickDirectory, PickFile, SaveConfig, UnloadAll,
        ClipboardGetText} from './Dept';
```
其余组件代码零改动。

### 4.9 `frontend/src/components/FilterBar.jsx`（修改）

第 2 行：`import {GetTimeRange} from '../../wailsjs/go/main/App';` → `import {GetTimeRange} from '../../Dept';`

### 4.10 `frontend/package.json`（修改）

`scripts` 新增：
```json
"build:web": "vite build --mode web"
```

### 4.11 `frontend/vite.config.js`（修改）

```js
import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({mode}) => ({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    outDir: mode === 'web' ? 'dist' : '../backend/frontend/dist',
    emptyOutDir: true
  }
}))
```
- 桌面 `wails build` / `npm run build` 仍输出 `../backend/frontend/dist`（Go embed 不变）。
- Web `npm run build:web` 输出 `frontend/dist`（已 gitignore）。

## 5. Go→JS 移植要点对照

| Go | JS | 注意 |
|---|---|---|
| `(?s)^…$` RE2 | `new RegExp(…, 's')` | 行已 Trim 尾换行，无 `$` 语义差异 |
| 命名组 `(?<date>…)` + `SubexpIndex` | `match.groups.date` | `m === null` 判未匹配 |
| `regexp.QuoteMeta` | `escapeRe` | 手动转义 |
| `bytes.ToLower` + `Contains` | `toLowerCase().includes` | Unicode 语义更宽松 |
| `time.Date(…, time.Local).Unix()` | `new Date(y,mo-1,…).getTime()/1000` | 本地时区一致 |
| 字节偏移 | 字符偏移 | 全程一致即可 |
| 并行 chunk 解析 | 顺序解析 + 每 5k 行 yield | 保持 UI 响应 |
| `os.TempDir` 配置 | `localStorage` | |
| 系统对话框 | FS Access API / input | |
| 写文件导出 | Blob + `<a download>` | 含 BOM |

## 6. Cloudflare Pages 部署步骤

1. 推送仓库（`frontend/dist` 与 `backend/frontend/dist` 均已被 gitignore，不入库）。
2. Cloudflare Pages → Create Project → 连接仓库。
3. 设置：
   - **Root directory**: `frontend`
   - **Build command**: `npm install && npm run build:web`
   - **Build output directory**: `dist`
4. 无需任何服务端运行时，所有解析在浏览器本地完成。
5. 注意：File System Access API 要求 HTTPS（Cloudflare 自带）+ Chromium；Firefox/Safari 自动降级为文件选择框。

## 7. 验证步骤

桌面端（回归，确保不受影响）：
```
cd frontend; npm run build
cd backend;  go vet ./...; go test ./...
# 或直接跑 build.bat
```
Web 端（浏览器冒烟）：
```
cd frontend; npm run build:web; npx serve dist
```
打开后逐一验证：打开目录/文件 → 加载 → 列显示 → 自动识别格式 → 时间/级别/关键字过滤 → 分页加载更多 → 双击加入过滤 → 对比队列 → CSV 导出（下载文件含 BOM、中文正常）→ 剪贴板粘贴日志 → 设置（格式/年份）→ 刷新后配置恢复。

## 8. 已知限制与后续优化

- Firefox/Safari 无目录列表，只能直接选文件。
- 大文件整读入内存（JS string 约为文件 2 倍大小）；后续可用 Web Worker 并行解析 + 分片读取优化。
- 无 JS 测试框架：移植正确性以浏览器冒烟测试为准；后续可选引入 Vitest，把 `parser.js/detect.js` 用样例日志做快照测试。
- 关键词大小写匹配从 ASCII 字节比较变为 Unicode 语义，对 ASCII 日志无感知差异。

## 9. 风险点

- 正则语义：JS 正则支持 RE2 不支持的 lookahead/backref（本方案未用），但 `$` 语义略不同——已通过行 Trim 规避。
- `GetWorkingDir` 在 Web 返回 `dir:N` 合成 id，`FilePanel` 只做展示，无副作用。
- 若 wails 重新生成绑定（`wails generate module`）会覆盖 `wailsjs/`，但 `Dept.js` 只依赖稳定的导出名，不受影响。

## 10. 修改进度跟踪

> 状态：⬜ 待办 / 🔄 进行中 / ✅ 完成 / ⛔ 取消
> 说明：3 个后端测试（`TestRealSample`/`TestParseSample`/`TestFilter`）因仓库缺少样例 `../xxl.log` 而失败，属**既有环境问题**，与本次改动无关（本改动不涉及 Go 后端）。

| # | 任务 | 状态 | 备注 |
|---|---|---|---|
| 1 | 编写方案文档（本文件） | ✅ | |
| 2 | `dept/pattern.js`（模式编译） | ✅ | |
| 3 | `dept/date.js`（日期解析） | ✅ | |
| 4 | `dept/detect.js`（自动识别） | ✅ | |
| 5 | `dept/parser.js`（解析管线） | ✅ | |
| 6 | `dept/filter.js`（过滤/分页/CSV） | ✅ | |
| 7 | `dept/webApp.js`（浏览器 API） | ✅ | |
| 8 | `Dept.js` 门面 | ✅ | |
| 9 | 改 `App.jsx` / `FilterBar.jsx` 导入 | ✅ | FilterBar 用 `../Dept`（位于 src 内） |
| 10 | `package.json` build:web + `vite.config` mode 分支 | ✅ | |
| 11 | 桌面回归：`npm run build` + `go vet/test` | ✅ | build 通过；go vet 通过；3 个样例测试因缺 `../xxl.log` 失败（既有） |
| 12 | Web 构建：`npm run build:web` | ✅ | 输出 `frontend/dist` 成功 |
| 13 | JS 管线冒烟（Node）：pattern/detect/parser/filter/CSV | ✅ | 结构化+启发式解析、自动识别、过滤、折叠、导出均验证通过 |
| 14 | 浏览器端人工冒烟（可选，待用户操作） | ⬜ | 打开 `npm run build:web` 产物验证目录/文件加载等 |
