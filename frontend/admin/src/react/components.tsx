import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'

export function Icon({ name }: { name: string }) {
  return <i className={`fas fa-${name}`} aria-hidden="true" />
}

export function Button({ children, variant = 'secondary', className = '', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' }) {
  return <button type="button" className={`admin-react-button admin-react-button-${variant} ${className}`} {...props}>{children}</button>
}

export type AdminSelectOption = { value: string; label: string; disabled?: boolean }

export function SelectMenu({ value, options, onChange, label, disabled = false }: { value: string; options: AdminSelectOption[]; onChange: (value: string) => void; label: string; disabled?: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listboxId = useId()
  const [open, setOpen] = useState(false)
  const selected = options.find(option => option.value === value)
  const [highlighted, setHighlighted] = useState(Math.max(0, options.findIndex(option => option.value === value)))
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => { if (!rootRef.current?.contains(event.target as Node)) setOpen(false) }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setOpen(false); triggerRef.current?.focus() } }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown); document.removeEventListener('keydown', onKeyDown) }
  }, [open])
  const move = (direction: 1 | -1) => {
    if (!options.length) return
    let next = highlighted
    for (let index = 0; index < options.length; index += 1) { next = (next + direction + options.length) % options.length; if (!options[next]?.disabled) break }
    setHighlighted(next)
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); setOpen(true); move(1) }
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); setOpen(true); move(-1) }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(current => !current) }
    else if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
  }
  const choose = (option: AdminSelectOption) => { if (option.disabled) return; onChange(option.value); setOpen(false); window.requestAnimationFrame(() => triggerRef.current?.focus()) }
  return <div ref={rootRef} className={`admin-react-select ${open ? 'is-open' : ''}`}><button ref={triggerRef} type="button" className="admin-react-select-trigger" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={listboxId} disabled={disabled} onClick={() => setOpen(current => !current)} onKeyDown={onKeyDown}><span>{selected?.label ?? '请选择'}</span><Icon name="chevron-down" /></button>{open && <div id={listboxId} className="admin-react-select-list" role="listbox" aria-label={label}>{options.map((option, index) => <button key={`${option.value}-${index}`} type="button" role="option" aria-selected={option.value === value} className={option.value === value ? 'is-selected' : ''} disabled={option.disabled} onMouseEnter={() => setHighlighted(index)} onClick={() => choose(option)}><span>{option.label}</span>{option.value === value && <Icon name="check" />}</button>)}</div>}</div>
}

export function StatCard({ label, value, icon }: { label: string; value: ReactNode; icon: string }) {
  return <article className="admin-react-stat glass"><div className="admin-react-stat-icon"><Icon name={icon} /></div><div><p>{label}</p><strong>{value}</strong></div></article>
}

export function Panel({ title, children, actions, className = '' }: { title: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return <section className={`admin-react-panel glass ${className}`.trim()}><div className="admin-react-panel-header"><h2>{title}</h2>{actions}</div>{children}</section>
}

export function ErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  if (!message) return null
  return <div className="admin-react-error" role="alert"><Icon name="triangle-exclamation" /><span>{message}</span>{onRetry && <Button onClick={onRetry}>重试</Button>}</div>
}

export function Modal({ open, title, onClose, children, labelledBy, className = '' }: { open: boolean; title: string; onClose: () => void; children: ReactNode; labelledBy?: string; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  const generatedTitleId = useId()
  const titleId = labelledBy ?? generatedTitleId
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      dialog.showModal()
      dialog.querySelector<HTMLElement>('[autofocus], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)')?.focus()
    } else if (!open && dialog.open) {
      dialog.close()
      const focusTarget = previousFocus.current
      if (focusTarget?.isConnected && focusTarget !== document.body && !dialog.contains(focusTarget) && !focusTarget.matches(':disabled')) focusTarget.focus()
      else window.requestAnimationFrame(() => document.getElementById('admin-main')?.focus())
      previousFocus.current = null
    }
  }, [open])
  return <dialog ref={ref} className={`admin-react-dialog ${className}`.trim()} aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); onClose() }}>
    <div className="admin-react-dialog-content">
      <header><h2 id={titleId}>{title}</h2><button type="button" className="admin-react-icon-button" aria-label="关闭" onClick={onClose}><Icon name="xmark" /></button></header>
      <div className="admin-react-dialog-body">{children}</div>
    </div>
  </dialog>
}

export function ConfirmDialog({ open, title, message, confirmLabel = '确认', onClose, onConfirm }: { open: boolean; title: string; message: string; confirmLabel?: string; onClose: () => void; onConfirm: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (!open) setBusy(false) }, [open])
  const confirm = async () => {
    setBusy(true)
    try { await onConfirm() } finally { setBusy(false); onClose() }
  }
  return <Modal open={open} title={title} onClose={onClose}>
    <p className="admin-react-confirm-message">{message}</p>
    <div className="admin-react-dialog-actions"><Button onClick={onClose} disabled={busy}>取消</Button><Button variant="danger" onClick={() => void confirm()} disabled={busy}>{busy ? '处理中…' : confirmLabel}</Button></div>
  </Modal>
}

export function Loading({ label = '加载中…' }: { label?: string }) {
  return <div className="admin-react-loading" role="status"><Icon name="spinner" /><span>{label}</span></div>
}

export function Empty({ label }: { label: string }) {
  return <div className="admin-react-empty"><Icon name="inbox" /><p>{label}</p></div>
}

export function formatUptime(seconds: unknown): string {
  const value = Math.max(0, Number(seconds) || 0)
  const days = Math.floor(value / 86400)
  const hours = Math.floor(value / 3600) % 24
  const minutes = Math.floor(value / 60) % 60
  return days ? `${days}天 ${hours}小时` : `${hours}小时 ${minutes}分`
}
