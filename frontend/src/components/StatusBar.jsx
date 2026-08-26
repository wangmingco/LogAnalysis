import React from 'react';

function StatusBar({status, loadedRecords}) {
    return (
        <footer className="status-bar">
            <span className="status-dot"></span>
            <span className="status-item">已加载记录: <b>{loadedRecords}</b></span>
            <span className="status-text">{status}</span>
            <div className="status-links">
                <a href="https://github.com/wangmingco/LogAnalysis" target="_blank" rel="noopener noreferrer">GitHub 仓库</a>
                <a href="https://github.com/wangmingco/LogAnalysis/releases" target="_blank" rel="noopener noreferrer">桌面端下载</a>
            </div>
        </footer>
    );
}

export default StatusBar;