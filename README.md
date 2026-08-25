# LogAnalysis · 日志分析器

基于 [Wails v2](https://wails.io) 的 Windows 桌面日志分析工具：Go 后端 + React 19 前端，用于快速加载、过滤、定位和对比大型日志文件。

## 功能特性

- **加载日志**：选择目录（递归）或单个文件，支持 `.log` / `.txt` / `.out`，多文件并行解析、去重加载。
- **过滤**：关键字（多个关键字需全部命中）、级别、时间范围，结果可滚动分页加载。
- **格式自动识别**：不设置格式时，自动从多个文件窗口采样、对 log4j/logback 常用 pattern 打分识别，支持混合格式文件（主格式 + 备用格式）；也支持手动输入 logback 风格格式。
- **逻辑记录折叠**：多行堆栈/续行合并为一条逻辑记录，并统计物理行/折叠行，便于理解"记录数 ≠ 行数"。
- **结果列表**：虚拟滚动、行级关键字高亮、右键范围高亮（前/后 N 行、前/后 N 秒）、列隐藏/显示、双击单元格快捷添加关键字过滤（超过 20 字符不添加）。
- **日志对比**：日志行右键「加入对比」→ 点击「对比」打开全屏对比工作区（顶部对比队列 + 左右文本对比），支持编辑、JSON/SQL 格式化、正则替换、复制/还原、字符级差异高亮、自动换行。

## 环境要求

- Go 1.25+
- Node.js 20.19+（Vite 7 要求）与 npm
- Wails CLI v2（`go install github.com/wailsapp/wails/v2/cmd/wails@latest`）
- Windows WebView2 Runtime

## 构建与运行

仓库根目录提供一键脚本（在 `backend/` 下执行 `wails build`/`wails dev`，Go 模块位于 `backend/`）：

```bat
build.bat   REM 安装前端依赖 → 生成图标 → wails build → build\bin\loganalysis.exe
dev.bat     REM wails dev，前端热更新（Vite 开发服务器 http://127.0.0.1:5173）
run.bat     REM 启动已编译的 loganalysis.exe
```

手动等价命令：

```bash
# 前端生产构建（输出到 backend/frontend/dist，供 Go embed）
cd frontend && npm install && npm run build

# 后端构建 / 测试
cd backend && go build ./... && go test ./... && go vet ./...
```

## 项目结构

```
backend/                 Go 后端（单一 main 包）
  app.go                 App 结构体，绑定到前端的 IPC 方法（window.go.main.App.*）
  parser.go              日志解析管道：分块并行扫描 → groupRecords 折叠为逻辑记录
  pattern.go             logback/log4j 格式 → RE2 正则编译
  detect.go              未设置格式时的自动格式检测（多窗口采样 + 打分）
  filter.go              过滤与分页
frontend/                React 19 前端（JSX，无 TypeScript）
  src/components/        FilePanel / FilterBar / ResultList / DetailPane / CompareView / StatusBar
  src/lib/format.js      JSON/SQL 格式化、正则替换、差异对比（基于 diff 包）
  src/App.css            深色主题样式（CSS 变量）
  wailsjs/               Wails 自动生成的前端↔后端绑定（会随 wails build/dev 重新生成）
```

## 测试

```bash
cd backend && go test ./...
```

- 后端测试覆盖解析、格式检测、过滤与整机流程。
- 部分测试引用仓库根目录的样例日志（路径相对 `backend/` 为 `../logs-from-...log`）。
- 注意：`go build`/`go test` 依赖 `backend/frontend/dist`（vite 产物，被 `main.go` 通过 `//go:embed` 嵌入）。该目录缺失时编译会报 "file not found"，需先在 `frontend/` 执行 `npm run build`。
- 前端无 JS 测试框架与 lint，以 `npm run build` 编译通过作为验证。

## 注意事项

- `backend/go.mod` 含一条机器相关的 `replace` 指令，指向本机 wails 本地目录（`C:\Users\wang\go\pkg\mod`），在其他机器上可能需要移除或调整。
- 源文件与样例日志为 UTF-8 编码（含中文），Windows PowerShell 控制台可能乱码显示，不影响文件内容正确性。
- `npm run icons`（`frontend/scripts/gen-icons.mjs`）从 `frontend/public/favicon.svg` 生成各尺寸图标（public 下的 favicon-*.png/ico 与 build 下的图标均为生成物）。
