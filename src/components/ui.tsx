import {
  AlertCircle, BookOpen, Bot, CheckCircle2, Headset, Info, LoaderCircle, Megaphone, MessageSquare, NotebookPen, PenLine,
  ShieldCheck, Sparkles, TriangleAlert, X, type LucideIcon, Workflow } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type PropsWithChildren, type ReactNode } from 'react';
import { C } from '../theme';

/* -------- 应用图标：按模板 / 类型选择，保证同类应用在各页面一致 -------- */

const TEMPLATE_ICON: Record<string, [LucideIcon, string]> = {
  qa: [BookOpen, C.violet],
  content: [PenLine, C.rose],
  report: [NotebookPen, C.primary],
  review: [ShieldCheck, C.warning],
  customer_service: [Headset, C.success],
  marketing: [Megaphone, C.rose],
};

export function appVisual(templateKey: string | undefined, type?: string): [LucideIcon, string] {
  if (templateKey && TEMPLATE_ICON[templateKey]) return TEMPLATE_ICON[templateKey];
  return type === 'agent' ? [Bot, C.teal] : type === 'chatflow' ? [Workflow, C.primary] : [MessageSquare, C.primary];
}

export function AppTile({ templateKey, type, size = 'md' }: { templateKey?: string; type?: string; size?: 'sm' | 'md' | 'lg' }) {
  const [Icon, color] = appVisual(templateKey, type);
  const px = size === 'sm' ? 15 : size === 'lg' ? 22 : 19;
  return <span className={`avatar-tile ${size === 'md' ? '' : size}`} style={{ background: color }}><Icon size={px} aria-hidden="true" /></span>;
}

export function Tag({ tone = '', children, title }: PropsWithChildren<{ tone?: string; title?: string }>) {
  return <span className={`tag ${tone}`} title={title}>{children}</span>;
}

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} />;
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <LoaderCircle size={size} className="spin" aria-hidden="true" />;
}

export function Notice({ tone = 'info', title, children, action }: PropsWithChildren<{ tone?: 'info' | 'warn' | 'error' | 'success'; title?: ReactNode; action?: ReactNode }>) {
  const Icon = tone === 'error' ? AlertCircle : tone === 'warn' ? TriangleAlert : tone === 'success' ? CheckCircle2 : Info;
  return (
    <div className={`notice ${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      <Icon size={16} aria-hidden="true" />
      <div className="grow">{title ? <strong style={{ display: 'block' }}>{title}</strong> : null}{children}</div>
      {action}
    </div>
  );
}

export function Loading({ text = '加载中' }: { text?: string }) {
  return <div className="empty" aria-busy="true"><Spinner size={22} /><span>{text}</span></div>;
}

/* -------- Toast -------- */

type ToastTone = 'info' | 'error';
const ToastCtx = createContext<(text: string, tone?: ToastTone) => void>(() => undefined);

export function ToastProvider({ children }: PropsWithChildren) {
  const [items, setItems] = useState<{ id: number; text: string; tone: ToastTone }[]>([]);
  const show = useCallback((text: string, tone: ToastTone = 'info') => {
    const id = Date.now() + Math.random();
    setItems((list) => [...list, { id, text, tone }]);
    window.setTimeout(() => setItems((list) => list.filter((i) => i.id !== id)), tone === 'error' ? 5000 : 2600);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className="toast-wrap" aria-live="polite">{items.map((i) => <div className={`toast ${i.tone === 'error' ? 'toast-error' : ''}`} key={i.id}>{i.tone === 'error' ? <AlertCircle size={15} /> : null}{i.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/* -------- Modal / Drawer -------- */

function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);
}

export function Modal({ open, title, onClose, children, footer, wide, icon }: PropsWithChildren<{ open: boolean; title: string; onClose: () => void; footer?: ReactNode; wide?: boolean; icon?: ReactNode }>) {
  useEscape(open, onClose);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) ref.current?.focus(); }, [open]);
  if (!open) return null;
  return (
    <div className="overlay modal-layer" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="modal-head">{icon}<h3>{title}</h3><button className="btn ghost sm icon" aria-label="关闭" onClick={onClose}><X size={16} /></button></div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Drawer({ open, title, onClose, children, footer, wide }: PropsWithChildren<{ open: boolean; title: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean }>) {
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <>
      <div className="overlay" style={{ background: 'rgba(16,24,40,.18)' }} onMouseDown={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" style={wide ? { width: 'min(880px, 100vw)' } : undefined}>
        <div className="modal-head" style={{ borderBottom: '1px solid var(--border)', paddingBottom: 14 }}><h3>{title}</h3><button className="btn ghost sm icon" aria-label="关闭" onClick={onClose}><X size={16} /></button></div>
        <div className="modal-body" style={{ flex: 1, paddingTop: 16 }}>{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </aside>
    </>
  );
}

export function Field({ label, required, hint, children }: PropsWithChildren<{ label: ReactNode; required?: boolean; hint?: ReactNode }>) {
  return (
    <div className="form-item">
      <div className="field-label">{label}{required ? <span className="req">*</span> : null}{hint ? <span className="hint">{hint}</span> : null}</div>
      {children}
    </div>
  );
}

export function Slider({ value, min, max, step = 1, onChange, suffix, label }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; suffix?: string; label?: string }) {
  return (
    <div className="slider-row">
      <input className="range" type="range" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <div className="row" style={{ flex: 'none' }}>
        <input className="input sm" type="number" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
        {suffix ? <span className="faint">{suffix}</span> : null}
      </div>
    </div>
  );
}

export function Empty({ icon, title, desc, action }: { icon?: ReactNode; title: string; desc?: string; action?: ReactNode }) {
  return <div className="empty">{icon ?? <Sparkles size={24} />}<strong style={{ color: 'var(--text-1)' }}>{title}</strong>{desc ? <span>{desc}</span> : null}{action}</div>;
}

export function ConfirmModal({ open, title, body, confirmText = '确认', danger, onConfirm, onClose }: { open: boolean; title: string; body: ReactNode; confirmText?: string; danger?: boolean; onConfirm: () => void | Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>取消</button><button className={`btn ${danger ? 'danger-solid' : 'primary'}`} disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } finally { setBusy(false); } }}>{busy ? <Spinner /> : null}{confirmText}</button></>}>
      <div className="muted">{body}</div>
    </Modal>
  );
}

/* -------- 格式化 -------- */

export function formatTime(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat('zh-CN', sameDay ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}

export function formatDuration(ms: number | null | undefined) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function formatTokens(n: number | null | undefined) {
  if (n == null) return '—';
  return n >= 1000000 ? `${(n / 1000000).toFixed(2)}M` : n >= 10000 ? `${(n / 1000).toFixed(1)}K` : n.toLocaleString();
}

export function formatCost(value: number | null | undefined, currency = 'USD') {
  if (value == null) return '未计价';
  const symbol = currency === 'CNY' ? '¥' : '$';
  return `${symbol}${value < 0.01 ? value.toFixed(5) : value < 10 ? value.toFixed(4) : value.toFixed(2)}`;
}

export function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}
