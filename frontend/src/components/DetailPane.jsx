import React from 'react';

function DetailPane({entry, height, onCollapse}) {
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
            <pre className="dp-body">{entry.text}</pre>
        </div>
    );
}

export default DetailPane;