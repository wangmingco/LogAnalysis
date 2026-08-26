import React, {useEffect, useRef, useState} from 'react';

function TextInputModal({onClose, onSubmit}) {
    const [text, setText] = useState('');
    const ref = useRef(null);

    const submit = () => {
        if (!text.trim()) return;
        onSubmit(text);
        onClose();
    };

    useEffect(() => {
        ref.current?.focus();
        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                submit();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div className="modal-mask" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="modal modal-wide">
                <div className="modal-head">
                    <span className="modal-title">输入日志文本</span>
                    <button className="icon-btn" title="关闭" onClick={onClose}>✕</button>
                </div>
                <div className="modal-body">
                    <div className="modal-desc">
                        在此粘贴或输入日志内容（支持多行）。可直接粘贴整个日志文本，Ctrl+Enter 确认加载。
                    </div>
                    <textarea
                        ref={ref}
                        className="modal-textarea"
                        placeholder="例如：08-16 21:30:22.903 INFO  LoggerA : first message&#10;08-16 21:30:25.100 ERROR LoggerB : second problem"
                        value={text}
                        onChange={e => setText(e.target.value)}
                        spellCheck={false}
                    />
                </div>
                <div className="modal-foot">
                    <button className="btn ghost" onClick={onClose}>取消</button>
                    <button className="btn primary" onClick={submit} disabled={!text.trim()}>加载</button>
                </div>
            </div>
        </div>
    );
}

export default TextInputModal;