// Dept.js — 统一后端门面。
// 桌面/开发构建（wails）→ 使用 wailsjs 绑定（Go 实现）；
// Web 构建（Cloudflare，vite --mode web）→ 使用 dept/webApp（JS 实现）。

import * as wailsApp from '../wailsjs/go/main/App';
import {ClipboardGetText as wailsClipboardGetText} from '../wailsjs/runtime/runtime';
import * as webApp from './dept/webApp';

const isWeb =
    import.meta.env.MODE === 'web' ||
    (typeof window !== 'undefined' && !window.go?.main?.App);

const impl = isWeb
    ? webApp
    : {...wailsApp, ClipboardGetText: wailsClipboardGetText};

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
