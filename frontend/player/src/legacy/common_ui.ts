function closeActiveTooltips(target: Element | null): void {
    document.querySelectorAll<HTMLElement>('.setting-tooltip-trigger.is-active').forEach(trigger => {
        if (trigger !== target) trigger.classList.remove('is-active');
    });
}

document.addEventListener('click', event => {
    const target = event.target as Element | null;
    const trigger = target?.closest('.setting-tooltip-trigger') || null;
    closeActiveTooltips(trigger);
    if (trigger && matchMedia('(hover: none)').matches) {
        trigger.classList.toggle('is-active');
        event.stopPropagation();
    }
});

document.addEventListener('touchstart', event => {
    const target = event.target as Element | null;
    if (!target?.closest('.setting-tooltip-trigger')) closeActiveTooltips(null);
}, { passive: true });

function checkProjectAgreement(): void {
    if (localStorage.getItem('lx_agreement_accepted') === 'true') return;
    const modal = document.getElementById('project-agreement-modal');
    if (!modal) return;
    document.body.appendChild(modal);
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
}

function acceptProjectAgreement(): void {
    localStorage.setItem('lx_agreement_accepted', 'true');
    const modal = document.getElementById('project-agreement-modal');
    if (!modal) return;
    modal.classList.add('opacity-0');
    setTimeout(() => {
        modal.classList.add('hidden');
        document.body.style.overflow = '';
    }, 300);
}

Object.assign(window, { checkProjectAgreement, acceptProjectAgreement });
document.addEventListener('DOMContentLoaded', checkProjectAgreement);
