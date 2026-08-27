import React, {useEffect, useRef, useState} from 'react';
import {formatJSON, formatSQL} from '../lib/format';

function DetailPane({entry, height, onCollapse}) {
    const [text, setText] = useState('');
    const [msg, setMsg] = useState('');
    const bodyRef = useRef(null);
    const msgTimer = useRef(null);

    const entryKey = entry ? entry.lineNo + '|' + entry.fileName : null;

    useEffect(() => {
        setText(entry ? entry.text : '');
        setMsg('');
    }, [entryKey]);

    const flash = (m) => {
        setMsg(m);
        if (msgTimer.current) clearTimeout(msgTimer.current);
        msgTimer.current = setTimeout(() => setMsg(''), 2000);
    };

    // Run a formatter against the selected text of the body when there is an
    // active selection, otherwise against the whole content. The formatted
    // result replaces only the selected range and is re-selected for review.
    const doFormat = (fmt, okLabel, errMsg) => {
        const el = bodyRef.current;
        const full = el ? el.value : text;
        const start = el ? el.selectionStart : 0;
        const end = el ? el.selectionEnd : 0;
        const hasSel = end > start;
        const target = hasSel ? full.slice(start, end) : full;
        const res = fmt(target);
        if (res === null) {
            flash(errMsg);
            return;
        }
        if (hasSel) {
            setText(full.slice(0, start) + res + full.slice(end));
            setTimeout(() => {
                if (el) {
                    el.focus();
                    el.setSelectionRange(start, start + res.length);
                }
            }, 0);
            flash(`${okLabel}（选中部分）`);
        } else {
            setText(res);
            flash(okLabel);
        }
    };

    const doJSON = () => doFormat(formatJSON, '已格式化 JSON', '不是有效的 JSON，无法格式化');
    const doSQL = () => doFormat(formatSQL, '已格式化 SQL', '未检测到可格式化的 SQL');
    const doRestore = () => {
        if (entry) setText(entry.text);
        flash('已还原为原始内容');
    };
    const doCopy = async () => {
        try {
            await navigator.clipboard.writeText(text);
            flash('已复制内容');
        } catch {
            flash('复制失败');
        }
    };

    if (!entry) {
        return (
            <div className="detail-pane placeholder" style={{height}}>
                <div className="dp-placeholder-inner">
                    <div className="dp-mark">◧</div>
                    <p>点击左侧任意日志行查看完整内容</p>
                    <p className="dp-hint">包含多行堆栈、完整原始文本</p>
                </div>
            </div>
        );
    }
    return (
        <div className="detail-pane" style={{height}}>
            <div className="dp-head">
                <span className="dp-title">记录详情</span>
                <span className="dp-head-right">
                    <span className="dp-line">行号 {entry.lineNo}</span>
                    <span className="dp-actions">
                        <button className="btn ghost mini" title="格式化 JSON" onClick={doJSON}>JSON</button>
                        <button className="btn ghost mini" title="格式化 SQL" onClick={doSQL}>SQL</button>
                        <button className="btn ghost mini" title="复制内容" onClick={doCopy}>复制</button>
                        <button className="btn ghost mini" title="还原为原始内容" onClick={doRestore}>还原</button>
                        {msg && <span className="dp-msg">{msg}</span>}
                    </span>
                    <button className="icon-btn" title="收起详情" onClick={onCollapse}>▾</button>
                </span>
            </div>
            <div className="dp-meta">
                {entry.fileName && (
                    <div className="dp-meta-item"><span>文件</span><code>{entry.fileName}</code></div>
                )}
                <div className="dp-meta-item"><span>时间</span><code>{entry.time}</code></div>
                <div className="dp-meta-item"><span>级别</span><code>{entry.level}</code></div>
                <div className="dp-meta-item"><span>Logger</span><code>{entry.logger}</code></div>
            </div>
            <textarea className="dp-body" ref={bodyRef} value={text} onChange={e => setText(e.target.value)} spellCheck={false} />
        </div>
    );
}

export default DetailPane;