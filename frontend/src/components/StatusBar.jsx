import React from 'react';

function StatusBar({status, total, loaded}) {
    return (
        <footer className="status-bar">
            <span className="status-dot"></span>
            <span className="status-text">{status}</span>
            <div className="status-right">
                <span className="status-item">已加载文件: <b>{loaded}</b></span>
                <span className="status-item">匹配总数: <b>{total}</b></span>
            </div>
        </footer>
    );
}

export default StatusBar;