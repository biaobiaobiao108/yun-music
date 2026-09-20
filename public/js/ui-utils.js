/* 
   UI Utilities for 云音管理控制台
   Standardizes notifications (Toasts) and Dialogs
*/

(function () {
    function escapeHtml(value) {
        const element = document.createElement('div');
        element.textContent = String(value ?? '');
        return element.innerHTML;
    }

    // 1. 注入现代白色玻璃风格样式
    const style = document.createElement('style');
    style.textContent = `
        @keyframes toast-slide-down {
            0% {
                transform: translateY(-24px) scale(0.96);
                opacity: 0;
            }
            100% {
                transform: translateY(0) scale(1);
                opacity: 1;
            }
        }
        @keyframes toast-slide-up {
            0% {
                transform: translateY(0) scale(1);
                opacity: 1;
                max-height: 120px;
                margin-bottom: 10px;
            }
            100% {
                transform: translateY(-16px) scale(0.94);
                opacity: 0;
                max-height: 0;
                margin-bottom: 0;
                padding-top: 0;
                padding-bottom: 0;
            }
        }
        @keyframes modal-fade-in {
            from { transform: scale(0.96) translateY(8px); opacity: 0; }
            to { transform: scale(1) translateY(0); opacity: 1; }
        }
        @keyframes marquee {
            0% { transform: translateX(0); }
            100% { transform: translateX(-50%); }
        }
        
        #lx-toast-container {
            position: fixed;
            top: 24px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 10000;
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 10px;
            pointer-events: none;
            width: auto;
            max-width: min(92vw, 560px);
        }

        .toast-item {
            pointer-events: auto;
            animation: toast-slide-down 0.32s cubic-bezier(0.16, 1, 0.3, 1) forwards;
            transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .toast-item.toast-leave {
            animation: toast-slide-up 0.24s cubic-bezier(0.4, 0, 1, 1) forwards;
            overflow: hidden;
        }

        /* 现代轻质玻璃拟态风格 Toast 卡片 */
        .lx-toast-card {
            font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            background: rgba(255, 255, 255, 0.96) !important;
            backdrop-filter: blur(20px) saturate(180%) !important;
            -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
            border-radius: 14px !important;
            padding: 10px 16px 10px 12px !important;
            display: flex !important;
            align-items: center !important;
            gap: 12px !important;
            min-width: 240px !important;
            max-width: 520px !important;
            box-sizing: border-box !important;
            transition: all 0.2s ease !important;
        }

        .lx-toast-card.success {
            border: 1px solid rgba(16, 185, 129, 0.28) !important;
            box-shadow: 0 12px 32px -4px rgba(16, 185, 129, 0.16), 0 4px 14px -2px rgba(23, 33, 29, 0.06) !important;
        }
        .lx-toast-card.info {
            border: 1px solid rgba(59, 130, 246, 0.28) !important;
            box-shadow: 0 12px 32px -4px rgba(59, 130, 246, 0.16), 0 4px 14px -2px rgba(23, 33, 29, 0.06) !important;
        }
        .lx-toast-card.error {
            border: 1px solid rgba(239, 68, 68, 0.28) !important;
            box-shadow: 0 12px 32px -4px rgba(239, 68, 68, 0.16), 0 4px 14px -2px rgba(23, 33, 29, 0.06) !important;
        }
        .lx-toast-card.warning {
            border: 1px solid rgba(245, 158, 11, 0.28) !important;
            box-shadow: 0 12px 32px -4px rgba(245, 158, 11, 0.16), 0 4px 14px -2px rgba(23, 33, 29, 0.06) !important;
        }

        .lx-toast-icon-wrapper {
            width: 32px;
            height: 32px;
            border-radius: 9px;
            display: flex;
            align-items: center;
            justify-content: center;
            flex-shrink: 0;
        }
        .lx-toast-icon-wrapper.success {
            background: rgba(16, 185, 129, 0.12);
            color: #0f9f6e;
        }
        .lx-toast-icon-wrapper.info {
            background: rgba(59, 130, 246, 0.12);
            color: #2563eb;
        }
        .lx-toast-icon-wrapper.error {
            background: rgba(239, 68, 68, 0.12);
            color: #dc2626;
        }
        .lx-toast-icon-wrapper.warning {
            background: rgba(245, 158, 11, 0.12);
            color: #d97706;
        }

        .lx-toast-message {
            font-size: 0.885rem !important;
            font-weight: 600 !important;
            color: #17211d !important;
            line-height: 1.45 !important;
            white-space: pre-line !important;
            word-break: break-word !important;
            flex: 1 !important;
            padding-right: 4px !important;
        }

        .lx-toast-close {
            width: 24px !important;
            height: 24px !important;
            border-radius: 50% !important;
            border: none !important;
            background: transparent !important;
            color: #87968f !important;
            cursor: pointer !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            flex-shrink: 0 !important;
            padding: 0 !important;
            transition: all 0.2s ease !important;
        }
        .lx-toast-close:hover {
            background: rgba(23, 33, 29, 0.06) !important;
            color: #17211d !important;
        }

        /* 现代磨砂玻璃风格对话框 */
        .lx-dialog-overlay {
            position: fixed;
            inset: 0;
            z-index: 3000;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 1.5rem;
            background: rgba(15, 23, 42, 0.45);
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
            transition: opacity 0.25s ease;
        }

        .lx-dialog-card {
            font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            background: rgba(255, 255, 255, 0.96) !important;
            backdrop-filter: blur(24px) saturate(180%) !important;
            -webkit-backdrop-filter: blur(24px) saturate(180%) !important;
            border: 1px solid rgba(23, 33, 29, 0.1) !important;
            border-radius: 22px !important;
            box-shadow: 0 24px 52px -12px rgba(23, 33, 29, 0.22), 0 4px 16px -2px rgba(23, 33, 29, 0.06) !important;
            color: #17211d !important;
            width: 100% !important;
            max-width: 400px !important;
            overflow: hidden !important;
            position: relative !important;
            animation: modal-fade-in 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards !important;
        }

        .lx-dialog-close-btn {
            position: absolute !important;
            top: 1rem !important;
            right: 1rem !important;
            width: 32px !important;
            height: 32px !important;
            border-radius: 50% !important;
            border: none !important;
            background: transparent !important;
            color: #87968f !important;
            cursor: pointer !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            transition: all 0.2s ease !important;
            z-index: 10 !important;
        }
        .lx-dialog-close-btn:hover {
            background: rgba(23, 33, 29, 0.06) !important;
            color: #17211d !important;
        }

        .lx-dialog-body {
            padding: 2rem 1.75rem 1.25rem !important;
            display: flex !important;
            flex-direction: column !important;
            align-items: center !important;
            text-align: center !important;
            gap: 1rem !important;
        }

        .lx-dialog-icon-badge {
            width: 56px !important;
            height: 56px !important;
            border-radius: 18px !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            margin-bottom: 0.25rem !important;
        }
        .lx-dialog-icon-badge.danger {
            background: rgba(239, 68, 68, 0.1) !important;
            color: #ef4444 !important;
            border: 1px solid rgba(239, 68, 68, 0.2) !important;
        }
        .lx-dialog-icon-badge.normal {
            background: rgba(15, 159, 110, 0.1) !important;
            color: #0f9f6e !important;
            border: 1px solid rgba(15, 159, 110, 0.2) !important;
        }

        .lx-dialog-title {
            color: #17211d !important;
            font-weight: 700 !important;
            font-size: 1.15rem !important;
            margin: 0 !important;
            letter-spacing: -0.01em !important;
        }

        .lx-dialog-message {
            color: #5f7067 !important;
            font-size: 0.9rem !important;
            line-height: 1.55 !important;
            margin: 0 !important;
            white-space: pre-line !important;
            word-break: break-word !important;
            padding: 0 0.5rem !important;
        }

        .lx-dialog-input {
            width: 100% !important;
            background: #ffffff !important;
            border: 1px solid rgba(23, 33, 29, 0.15) !important;
            border-radius: 12px !important;
            color: #17211d !important;
            padding: 0.75rem 1rem !important;
            font-size: 0.95rem !important;
            outline: none !important;
            transition: all 0.2s ease !important;
            box-sizing: border-box !important;
            margin-top: 0.75rem !important;
        }
        .lx-dialog-input:focus {
            border-color: #0f9f6e !important;
            box-shadow: 0 0 0 3px rgba(15, 159, 110, 0.15) !important;
        }

        .lx-dialog-footer {
            padding: 1rem 1.75rem 1.75rem !important;
            display: flex !important;
            gap: 0.75rem !important;
        }

        .lx-dialog-btn-cancel {
            flex: 1 !important;
            background: #f1f5f9 !important;
            color: #475569 !important;
            border: 1px solid rgba(23, 33, 29, 0.08) !important;
            border-radius: 12px !important;
            font-weight: 600 !important;
            padding: 0.75rem 1rem !important;
            font-size: 0.9rem !important;
            cursor: pointer !important;
            transition: all 0.2s ease !important;
        }
        .lx-dialog-btn-cancel:hover {
            background: #e2e8f0 !important;
            color: #1e293b !important;
        }

        .lx-dialog-btn-confirm {
            flex: 1 !important;
            border: none !important;
            border-radius: 12px !important;
            font-weight: 600 !important;
            padding: 0.75rem 1rem !important;
            font-size: 0.9rem !important;
            cursor: pointer !important;
            transition: all 0.2s ease !important;
            color: #ffffff !important;
        }
        .lx-dialog-btn-confirm.normal {
            background: linear-gradient(135deg, #0f9f6e, #0f766e) !important;
            box-shadow: 0 4px 14px rgba(15, 159, 110, 0.28) !important;
        }
        .lx-dialog-btn-confirm.normal:hover {
            filter: brightness(1.08) !important;
            transform: translateY(-1px) !important;
        }
        .lx-dialog-btn-confirm.danger {
            background: linear-gradient(135deg, #ef4444, #dc2626) !important;
            box-shadow: 0 4px 14px rgba(239, 68, 68, 0.28) !important;
        }
        .lx-dialog-btn-confirm.danger:hover {
            filter: brightness(1.08) !important;
            transform: translateY(-1px) !important;
        }
        .lx-dialog-btn-confirm:active, .lx-dialog-btn-cancel:active {
            transform: translateY(0) !important;
        }
    `;
    document.head.appendChild(style);

    function getToastContainer() {
        let container = document.getElementById('lx-toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'lx-toast-container';
            document.body.appendChild(container);
        }
        return container;
    }

    const toastIcons = {
        success: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`,
        info: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><circle cx="12" cy="8" r="0.75" fill="currentColor"/></svg>`,
        error: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
        warning: `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><circle cx="12" cy="17" r="0.75" fill="currentColor"/></svg>`
    };

    /**
     * 优雅顶部轻提示 (Toast)
     */
    function showToast(type, message, duration = 2500) {
        const validTypes = ['success', 'info', 'error', 'warning'];
        const toastType = validTypes.includes(type) ? type : 'info';
        const iconSvg = toastIcons[toastType];

        const container = getToastContainer();
        const toast = document.createElement('div');
        toast.className = 'toast-item';

        toast.innerHTML = `
            <div class="lx-toast-card ${toastType}">
                <div class="lx-toast-icon-wrapper ${toastType}">
                    ${iconSvg}
                </div>
                <div class="lx-toast-message"></div>
                <button type="button" class="lx-toast-close" title="关闭" aria-label="关闭">
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="18" y1="6" x2="6" y2="18"/>
                        <line x1="6" y1="6" x2="18" y2="18"/>
                    </svg>
                </button>
            </div>
        `;
        toast.querySelector('.lx-toast-message').textContent = String(message ?? '');

        container.appendChild(toast);

        let removed = false;
        const removeToast = () => {
            if (removed) return;
            removed = true;
            toast.classList.add('toast-leave');
            setTimeout(() => {
                toast.remove();
            }, 240);
        };

        const timer = setTimeout(removeToast, duration);
        const closeBtn = toast.querySelector('.lx-toast-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                clearTimeout(timer);
                removeToast();
            });
        }
    }

    /**
     * 对话框键盘无障碍与焦点捕获
     */
    let dialogSeq = 0;

    function enhanceDialog(modal, onConfirm, onCancel) {
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        if (!modal.hasAttribute('tabindex')) modal.setAttribute('tabindex', '-1');

        const title = modal.querySelector('h3');
        if (title) {
            const titleId = `lx-dialog-title-${++dialogSeq}`;
            title.id = titleId;
            modal.setAttribute('aria-labelledby', titleId);
        }

        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

        const focusableElements = () => Array.from(modal.querySelectorAll(
            'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )).filter(el => el.getClientRects().length > 0);

        modal.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onCancel();
                return;
            }
            if (event.key === 'Enter') {
                if (document.activeElement instanceof HTMLButtonElement) return;
                event.preventDefault();
                onConfirm();
                return;
            }
            if (event.key !== 'Tab') return;

            const focusable = focusableElements();
            if (!focusable.length) {
                event.preventDefault();
                modal.focus({ preventScroll: true });
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (!modal.contains(document.activeElement)) {
                event.preventDefault();
                first.focus({ preventScroll: true });
            } else if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus({ preventScroll: true });
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus({ preventScroll: true });
            }
        });

        requestAnimationFrame(() => {
            if (modal.contains(document.activeElement)) return;
            const focusable = focusableElements();
            (focusable[0] || modal).focus({ preventScroll: true });
        });

        return () => {
            if (previousFocus && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
        };
    }

    /**
     * 现代磨砂玻璃确认框 (showSelect)
     */
    function showSelect(title, message, options = {}) {
        const {
            confirmText = '确定',
            cancelText = '取消',
            danger = false
        } = options;

        const iconBadgeClass = danger ? 'danger' : 'normal';
        const confirmBtnClass = danger ? 'danger' : 'normal';
        const dialogIcon = danger
            ? `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><circle cx="12" cy="17" r="0.8" fill="currentColor"/></svg>`
            : `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = "lx-dialog-overlay";
            modal.innerHTML = `
                <div class="lx-dialog-card">
                    <button id="modal-close-x" class="lx-dialog-close-btn" aria-label="关闭">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                    <div class="lx-dialog-body">
                        <div class="lx-dialog-icon-badge ${iconBadgeClass}">
                            ${dialogIcon}
                        </div>
                        <div style="display:flex; flex-direction:column; gap:6px; width:100%;">
                            <h3 class="lx-dialog-title"></h3>
                            <p class="lx-dialog-message"></p>
                        </div>
                    </div>
                    <div class="lx-dialog-footer">
                        <button id="confirm-cancel" class="lx-dialog-btn-cancel"></button>
                        <button id="confirm-ok" class="lx-dialog-btn-confirm ${confirmBtnClass}"></button>
                    </div>
                </div>
            `;

            modal.querySelector('h3').textContent = String(title ?? '');
            const messageElement = modal.querySelector('.lx-dialog-message');
            messageElement.textContent = String(message ?? '');
            modal.querySelector('#confirm-cancel').textContent = String(cancelText ?? '取消');
            modal.querySelector('#confirm-ok').textContent = String(confirmText ?? '确定');

            document.body.appendChild(modal);

            let closed = false;
            let restoreFocus = () => {};
            const close = (result) => {
                if (closed) return;
                closed = true;
                modal.style.opacity = '0';
                const card = modal.querySelector('.lx-dialog-card');
                if (card) {
                    card.style.transform = 'scale(0.95) translateY(8px)';
                    card.style.opacity = '0';
                }
                setTimeout(() => {
                    modal.remove();
                    restoreFocus();
                    resolve(result);
                }, 220);
            };

            restoreFocus = enhanceDialog(modal, () => close(true), () => close(false));

            modal.querySelector('#confirm-ok')?.addEventListener('click', () => close(true));
            modal.querySelector('#confirm-cancel')?.addEventListener('click', () => close(false));
            modal.querySelector('#modal-close-x')?.addEventListener('click', () => close(false));
        });
    }

    /**
     * 现代磨砂玻璃输入框 (showInput)
     */
    function showInput(title, message, options = {}) {
        const {
            placeholder = '请输入内容...',
            defaultValue = '',
            confirmText = '确定',
            cancelText = '取消',
            inputType = 'text'
        } = options;
        const safeInputType = ['text', 'password', 'url', 'number', 'search'].includes(inputType) ? inputType : 'text';

        return new Promise((resolve) => {
            const modal = document.createElement('div');
            modal.className = "lx-dialog-overlay";
            modal.innerHTML = `
                <div class="lx-dialog-card">
                    <button id="modal-close-x" class="lx-dialog-close-btn" aria-label="关闭">
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                    <div class="lx-dialog-body">
                        <div class="lx-dialog-icon-badge normal">
                            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                        </div>
                        <div style="display:flex; flex-direction:column; gap:6px; width:100%;">
                            <h3 class="lx-dialog-title"></h3>
                            <p class="lx-dialog-message"></p>
                            <input type="text" id="modal-input" class="lx-dialog-input">
                        </div>
                    </div>
                    <div class="lx-dialog-footer">
                        <button id="confirm-cancel" class="lx-dialog-btn-cancel"></button>
                        <button id="confirm-ok" class="lx-dialog-btn-confirm normal"></button>
                    </div>
                </div>
            `;

            modal.querySelector('h3').textContent = String(title ?? '');
            modal.querySelector('.lx-dialog-message').textContent = String(message ?? '');
            modal.querySelector('#confirm-cancel').textContent = String(cancelText ?? '取消');
            modal.querySelector('#confirm-ok').textContent = String(confirmText ?? '确定');

            document.body.appendChild(modal);

            const input = modal.querySelector('#modal-input');
            input.type = safeInputType;
            input.placeholder = String(placeholder ?? '请输入内容...');
            input.value = String(defaultValue ?? '');
            input.focus();
            if (defaultValue) input.select();

            const close = (result) => {
                if (closed) return;
                closed = true;
                modal.style.opacity = '0';
                const card = modal.querySelector('.lx-dialog-card');
                if (card) {
                    card.style.transform = 'scale(0.95) translateY(8px)';
                    card.style.opacity = '0';
                }
                setTimeout(() => {
                    modal.remove();
                    restoreFocus();
                    resolve(result);
                }, 220);
            };

            let closed = false;
            let restoreFocus = () => {};
            restoreFocus = enhanceDialog(modal, () => close(input.value), () => close(null));

            modal.querySelector('#confirm-ok')?.addEventListener('click', () => close(input.value));
            modal.querySelector('#confirm-cancel')?.addEventListener('click', () => close(null));
            modal.querySelector('#modal-close-x')?.addEventListener('click', () => close(null));
        });
    }

    /**
     * 跑马灯辅助函数
     */
    function createMarqueeHtml(text, className = '') {
        return `<div class="truncate dynamic-marquee min-w-0 ${escapeHtml(className)}" data-text="${escapeHtml(text)}">${escapeHtml(text)}</div>`;
    }

    function applyMarqueeChecks() {
        setTimeout(() => {
            const elements = document.querySelectorAll('.dynamic-marquee.truncate');
            elements.forEach(el => {
                if (el.scrollWidth > el.clientWidth) {
                    const text = el.getAttribute('data-text') || el.innerText;
                    const gap = '<span class="mx-8"></span>';
                    el.classList.remove('truncate');
                    el.classList.add('overflow-hidden');
                    const maskStyle = 'mask-image: linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%); -webkit-mask-image: linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%);';
                    el.innerHTML = `
                    <div class="w-full relative" style="${maskStyle}">
                        <div class="inline-block whitespace-nowrap animate-marquee hover:pause-animation">
                            <span>${escapeHtml(text)}</span>${gap}<span>${escapeHtml(text)}</span>${gap}
                        </div>
                    </div>`;
                }
            });
        }, 50);
    }

    // 挂载至全局 window
    window.createMarqueeHtml = createMarqueeHtml;
    window.applyMarqueeChecks = applyMarqueeChecks;
    window.showToast = showToast;
    window.showSuccess = (msg) => showToast('success', msg, 2500);
    window.showInfo = (msg) => showToast('info', msg, 3000);
    window.showError = (msg) => showToast('error', msg, 3500);
    window.showSelect = showSelect;
    window.showInput = showInput;

    window.addEventListener('resize', () => {
        clearTimeout(window._marqueeResizeTimer);
        window._marqueeResizeTimer = setTimeout(applyMarqueeChecks, 300);
    });

})();
