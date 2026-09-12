import { escapeHtmlText } from './player_security';

export type InputDialogOptions = {
    placeholder?: string;
    defaultValue?: string;
    confirmText?: string;
    cancelText?: string;
    confirmColor?: string;
    inputType?: string;
};

/**
 * 弹出输入对话框，全面采用现代标准 HTML5 <dialog>
 */
export function showInput(title: string, message: string, options: InputDialogOptions = {}): Promise<string | null> {
    const {
        placeholder = '请输入内容...',
        defaultValue = '',
        confirmText = '确定',
        cancelText = '取消',
        confirmColor = 'bg-emerald-500',
        inputType = 'text'
    } = options;
    const safeTitle = escapeHtmlText(title);
    const safeMessage = escapeHtmlText(message);
    const safePlaceholder = escapeHtmlText(placeholder);
    const safeDefaultValue = escapeHtmlText(defaultValue);
    const safeConfirmText = escapeHtmlText(confirmText);
    const safeCancelText = escapeHtmlText(cancelText);
    const safeInputType = ['text', 'password', 'url', 'number', 'search'].includes(inputType) ? inputType : 'text';

    return new Promise((resolve) => {
        const dialog = document.createElement('dialog');
        dialog.id = `runtime-input-modal-${Date.now()}`;
        dialog.dataset.a11yOverlay = 'modal';
        dialog.className = "runtime-input-dialog m-auto bg-transparent p-4 outline-none border-none backdrop:bg-black/60 backdrop:backdrop-blur-sm";
        dialog.innerHTML = `
            <div class="runtime-input-dialog-panel t-bg-panel rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden transform transition-all relative z-10 animate-slide-up">
                <!-- Header -->
                <div class="px-6 py-5 flex justify-between items-center bg-emerald-50/60 dark:bg-emerald-500/10">
                    <h3 class="text-sm font-bold t-text-main">${safeTitle}</h3>
                    <button id="modal-close-x" data-overlay-close aria-label="关闭" class="t-text-muted hover:text-emerald-500 transition-colors">
                        <i class="fas fa-times text-lg"></i>
                    </button>
                </div>
                <!-- Body -->
                <div class="p-6">
                    <div class="flex items-start gap-4 mb-4">
                        <div class="w-10 h-10 rounded-full bg-emerald-50 text-emerald-500 flex items-center justify-center shrink-0">
                            <i class="fas fa-edit text-lg"></i>
                        </div>
                        <div class="flex-1">
                            <p class="text-sm t-text-muted leading-relaxed mb-4">${safeMessage}</p>
                            <input type="${safeInputType}" id="modal-input" autocomplete="off"
                                class="w-full px-4 py-2.5 t-bg-main border t-border-main rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-500 transition-all text-sm"
                                placeholder="${safePlaceholder}" value="${safeDefaultValue}">
                        </div>
                    </div>
                </div>
                <!-- Footer -->
                <div class="p-4 t-bg-main/50 flex gap-3 flex-row-reverse">
                    <button id="confirm-ok" class="flex-1 py-2.5 text-sm font-bold text-white ${confirmColor} hover:opacity-90 rounded-xl shadow-lg transition-all active:scale-95">
                        ${safeConfirmText}
                    </button>
                    <button id="confirm-cancel" class="flex-1 py-2.5 text-sm font-bold t-text-muted hover:t-text-main hover:bg-gray-100 dark:hover:bg-gray-700 rounded-xl transition-all">
                        ${safeCancelText}
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        const input = dialog.querySelector('#modal-input') as HTMLInputElement;

        let settled = false;
        const close = (result: string | null) => {
            if (settled) return;
            settled = true;
            try {
                if (typeof dialog.close === 'function' && dialog.open) {
                    dialog.close();
                }
            } catch {
                // Ignore any close failure
            }
            dialog.remove();
            resolve(result);
        };

        (dialog.querySelector('#confirm-ok') as HTMLElement).onclick = () => close(input.value.trim() || null);
        (dialog.querySelector('#confirm-cancel') as HTMLElement).onclick = () => close(null);
        (dialog.querySelector('#modal-close-x') as HTMLElement).onclick = () => close(null);

        // 点击 backdrop 关闭
        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) close(null);
        });

        // 监听原生 cancel 事件 (Escape)
        dialog.addEventListener('cancel', (e) => {
            e.preventDefault();
            close(null);
        });

        input.onkeydown = (e) => {
            if (e.key === 'Enter') close(input.value.trim() || null);
            if (e.key === 'Escape') {
                e.stopPropagation();
                close(null);
            }
        };

        if (typeof dialog.showModal === 'function') {
            dialog.showModal();
        } else {
            dialog.setAttribute('open', '');
        }

        input.focus();
        if (defaultValue) input.select();
    });
}

export type SelectDialogOptions = {
    confirmText?: string;
    cancelText?: string;
    confirmColor?: string;
    danger?: boolean;
};

/**
 * 弹出确认对话框，采用原生 HTML5 <dialog>
 */
export function showSelect(title: string, message: string, options: SelectDialogOptions = {}): Promise<boolean> {
    const {
        confirmText = '确定',
        cancelText = '取消',
        confirmColor = 'bg-emerald-500',
        danger = false
    } = options;

    const btnColor = danger ? 'bg-red-500 hover:bg-red-600 shadow-red-100' : `${confirmColor} hover:opacity-90 shadow-emerald-100`;
    const safeTitle = escapeHtmlText(title);
    const safeMessage = escapeHtmlText(message);
    const safeConfirmText = escapeHtmlText(confirmText);
    const safeCancelText = escapeHtmlText(cancelText);

    return new Promise((resolve) => {
        const dialog = document.createElement('dialog');
        dialog.id = `runtime-confirm-modal-${Date.now()}`;
        dialog.dataset.a11yOverlay = 'modal';
        dialog.className = "m-auto bg-transparent p-4 outline-none border-none backdrop:bg-black/60 backdrop:backdrop-blur-sm";
        dialog.innerHTML = `
            <div class="t-bg-panel rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden transform transition-all relative z-10 border t-border-main animate-slide-up">
                <!-- Header -->
                <div class="px-5 py-4 border-b border-emerald-100/50 flex justify-between items-center bg-emerald-50/50">
                    <h3 class="text-sm font-bold t-text-main">${safeTitle}</h3>
                    <button id="modal-close-x" data-overlay-close aria-label="关闭" class="t-text-muted hover:text-emerald-500 transition-colors">
                        <i class="fas fa-times text-lg"></i>
                    </button>
                </div>
                <!-- Body -->
                <div class="p-6">
                    <div class="flex items-start gap-4">
                        <div class="w-10 h-10 rounded-full ${danger ? 'bg-red-50 text-red-500' : 'bg-emerald-50 text-emerald-500'} flex items-center justify-center shrink-0">
                            <i class="fas ${danger ? 'fa-exclamation-triangle' : 'fa-question-circle'} text-lg"></i>
                        </div>
                        <div class="flex-1">
                            <p class="text-sm t-text-muted leading-relaxed">${safeMessage}</p>
                        </div>
                    </div>
                </div>
                <!-- Footer -->
                <div class="p-4 t-bg-main/50 border-t t-border-main/50 flex gap-3 flex-row-reverse">
                    <button id="confirm-ok" class="flex-1 py-2.5 text-sm font-bold text-white ${btnColor} rounded-xl shadow-lg transition-all active:scale-95">
                        ${safeConfirmText}
                    </button>
                    <button id="confirm-cancel" class="flex-1 py-2.5 text-sm font-bold t-text-muted hover:t-text-main hover:bg-gray-100 dark:hover:bg-gray-700 rounded-xl transition-all">
                        ${safeCancelText}
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        let settled = false;
        const close = (result: boolean) => {
            if (settled) return;
            settled = true;
            try {
                if (typeof dialog.close === 'function' && dialog.open) {
                    dialog.close();
                }
            } catch {
                // Ignore
            }
            dialog.remove();
            resolve(result);
        };

        (dialog.querySelector('#confirm-ok') as HTMLElement).onclick = () => close(true);
        (dialog.querySelector('#confirm-cancel') as HTMLElement).onclick = () => close(false);
        (dialog.querySelector('#modal-close-x') as HTMLElement).onclick = () => close(false);

        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) close(false);
        });

        dialog.addEventListener('cancel', (e) => {
            e.preventDefault();
            close(false);
        });

        if (typeof dialog.showModal === 'function') {
            dialog.showModal();
        } else {
            dialog.setAttribute('open', '');
        }

        const confirmBtn = dialog.querySelector('#confirm-ok') as HTMLButtonElement | null;
        confirmBtn?.focus();
    });
}

/**
 * 通用多选选择列表，采用原生 HTML5 <dialog>
 */
export function showOptions(title: string, message: string, options: string[] = []): Promise<string | null> {
    const safeTitle = escapeHtmlText(title);
    const safeMessage = escapeHtmlText(message);
    return new Promise((resolve) => {
        const dialog = document.createElement('dialog');
        dialog.id = `runtime-options-modal-${Date.now()}`;
        dialog.dataset.a11yOverlay = 'modal';
        dialog.className = "m-auto bg-transparent p-4 outline-none border-none backdrop:bg-black/60 backdrop:backdrop-blur-sm";

        const optionsHtml = options.map(opt => {
            const optionText = String(opt ?? '');
            const safeOption = escapeHtmlText(optionText);
            return `
            <button class="w-full text-left px-4 py-3.5 t-text-main hover:bg-emerald-500 hover:text-white transition-all rounded-xl font-bold text-sm flex items-center justify-between group" data-value="${safeOption}">
                <span>${safeOption}</span>
                <i class="fas fa-chevron-right text-[10px] opacity-0 group-hover:opacity-100 -translate-x-2 group-hover:translate-x-0 transition-all"></i>
            </button>
        `;
        }).join('');

        dialog.innerHTML = `
            <div class="t-bg-panel rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden transform transition-all relative z-10 border t-border-main animate-slide-up">
                <div class="px-5 py-4 border-b border-emerald-100/50 flex justify-between items-center bg-emerald-50/50">
                    <h3 class="text-sm font-bold t-text-main">${safeTitle}</h3>
                    <button id="opt-close-x" data-overlay-close aria-label="关闭" class="t-text-muted hover:text-emerald-500 transition-colors">
                        <i class="fas fa-times text-lg"></i>
                    </button>
                </div>
                <div class="p-3">
                    <p class="px-3 py-2 text-xs t-text-muted mb-2 font-medium">${safeMessage}</p>
                    <div class="max-h-[60vh] overflow-y-auto custom-scrollbar space-y-1">
                        ${optionsHtml}
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);

        let settled = false;
        const close = (result: string | null) => {
            if (settled) return;
            settled = true;
            try {
                if (typeof dialog.close === 'function' && dialog.open) {
                    dialog.close();
                }
            } catch {
                // Ignore
            }
            dialog.remove();
            resolve(result);
        };

        dialog.querySelectorAll('button[data-value]').forEach(btn => {
            (btn as HTMLElement).onclick = () => close(btn.getAttribute('data-value'));
        });

        (dialog.querySelector('#opt-close-x') as HTMLElement).onclick = () => close(null);

        dialog.addEventListener('click', (event) => {
            if (event.target === dialog) close(null);
        });

        dialog.addEventListener('cancel', (e) => {
            e.preventDefault();
            close(null);
        });

        if (typeof dialog.showModal === 'function') {
            dialog.showModal();
        } else {
            dialog.setAttribute('open', '');
        }

        const firstOption = dialog.querySelector('button[data-value]') as HTMLElement | null;
        firstOption?.focus();
    });
}

// 暴露全局兼容接口
(window as any).showInput = showInput;
(window as any).showSelect = showSelect;
(window as any).showOptions = showOptions;
