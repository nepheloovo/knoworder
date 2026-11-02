import { Activity, BookOpen, ChevronDown, ChevronRight, CircleAlert, Headset, Hourglass, RotateCcw, Send, ShieldQuestion, ThumbsDown, ThumbsUp, Wrench } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, errorMessage } from '../api/client';
import { fdeApi, type AppManifest, type Citation, type FlowRun, type FlowWaiting, type InputField, type RunPayload, type RunResult } from '../api/fde';
import { Markdown } from './Markdown';
import { AppTile, Drawer, Field, Notice, Spinner, Tag, formatDuration, useToast } from './ui';
import { C } from '../theme';

type Step = RunResult['agent_steps'][number];

interface Msg {
  id: string;
  role: 'user' | 'bot';
  content: string;
  pending?: boolean;
  error?: string;
  traceId?: string;
  steps?: Step[];
  citations?: Citation[];
  handoff?: boolean;
  messageId?: string;
  meta?: { tokens: number | null; duration: number; model?: string; simulated: boolean };
  request?: { message: string; inputs: Record<string, unknown> };
  /** Chat Flow 停在表单 / 用户选择，等待用户提交 */
  waiting?: FlowWaiting | null;
}

export type ChatMode = 'debug' | 'run' | 'share';

const STEP_ICON: Record<string, ReactNode> = {
  retrieval: <BookOpen size={13} color={C.success} />,
  handoff: <Headset size={13} color={C.warning} />,
  tool: <Wrench size={13} color={C.primary} />,
};

const STEP_LABEL = (step: Step) => step.label ?? (step.kind === 'retrieval' ? '知识库检索' : step.kind === 'handoff' ? '转人工' : step.tool);

function StepsView({ steps, open: initial }: { steps: Step[]; open: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <div style={{ marginBottom: 8 }}>
      <button className="tool-step" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {steps.map((step, index) => <span key={index} className="row" style={{ gap: 3 }}>{STEP_ICON[step.kind ?? 'tool']}{STEP_LABEL(step)}{step.status !== 'success' ? <Tag tone={step.status === 'confirmation_required' ? 'orange' : 'red'}>{step.status === 'confirmation_required' ? '待确认' : '失败'}</Tag> : null}</span>)}
      </button>
      {open ? (
        <div className="col" style={{ gap: 6, marginTop: 6, paddingLeft: 8, borderLeft: '2px solid var(--border)' }}>
          {steps.map((step, index) => (
            <div key={index} style={{ fontSize: 12 }}>
              <span className="row" style={{ gap: 4, fontWeight: 500 }}>{STEP_ICON[step.kind ?? 'tool']}{STEP_LABEL(step)}<span className="faint">第 {step.step} 轮{step.duration_ms != null ? ` · ${step.duration_ms}ms` : ''}</span></span>
              <div className="muted mono" style={{ marginLeft: 17, whiteSpace: 'pre-wrap' }}>参数：{JSON.stringify(step.arguments)}</div>
              <div className="muted mono clamp-3" style={{ marginLeft: 17, whiteSpace: 'pre-wrap' }}>结果：{step.result}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 只有一个必填文本字段的应用（如知识问答），把对话内容直接填进该字段。 */
export function inputsForMessage(manifest: AppManifest, message: string, values: Record<string, unknown>) {
  const next = { ...values };
  const required = manifest.input_fields.filter((field) => field.required && ['text', 'textarea'].includes(field.type) && !next[field.key]);
  if (required.length === 1 && message) next[required[0].key] = message;
  return next;
}

export function needsForm(manifest: AppManifest) {
  const textRequired = manifest.input_fields.filter((field) => field.required && ['text', 'textarea'].includes(field.type));
  return manifest.input_fields.length > 1 || manifest.input_fields.some((field) => field.required && !['text', 'textarea'].includes(field.type)) || textRequired.length > 1;
}

function fieldDefaults(fields: InputField[]) {
  return Object.fromEntries(fields.map((field) => [field.key, field.default ?? (field.type === 'boolean' ? false : '')]));
}

const defaults = (manifest: AppManifest) => fieldDefaults(manifest.input_fields);

export function InputForm({ fields, values, onChange }: { fields: InputField[]; values: Record<string, unknown>; onChange: (values: Record<string, unknown>) => void }) {
  return (
    <div className="grid c2" style={{ gap: '0 12px' }}>
      {fields.map((field) => (
        <div key={field.key} style={{ gridColumn: field.type === 'textarea' ? '1 / -1' : undefined }}>
          <Field label={field.label} required={field.required} hint={field.description}>
            {field.type === 'textarea' ? <textarea className="textarea" style={{ minHeight: 64 }} placeholder={field.placeholder} value={String(values[field.key] ?? '')} onChange={(event) => onChange({ ...values, [field.key]: event.target.value })} /> : null}
            {field.type === 'text' ? <input className="input" placeholder={field.placeholder} value={String(values[field.key] ?? '')} onChange={(event) => onChange({ ...values, [field.key]: event.target.value })} /> : null}
            {field.type === 'number' ? <input className="input" type="number" min={field.minimum ?? undefined} max={field.maximum ?? undefined} value={values[field.key] === '' || values[field.key] == null ? '' : Number(values[field.key])} onChange={(event) => onChange({ ...values, [field.key]: event.target.value === '' ? '' : Number(event.target.value) })} /> : null}
            {field.type === 'select' ? <select className="select" value={String(values[field.key] ?? '')} onChange={(event) => onChange({ ...values, [field.key]: event.target.value })}><option value="">请选择</option>{field.options.map((option) => <option key={option}>{option}</option>)}</select> : null}
            {field.type === 'boolean' ? <label className="row"><input type="checkbox" checked={Boolean(values[field.key])} onChange={(event) => onChange({ ...values, [field.key]: event.target.checked })} />是</label> : null}
          </Field>
        </div>
      ))}
    </div>
  );
}

/** Chat Flow 暂停处：表单填写或选项按钮，提交后流程从这一步继续。 */
function FlowStep({ waiting, busy, onSubmit }: { waiting: FlowWaiting; busy: boolean; onSubmit: (values: Record<string, unknown>, summary: string) => void }) {
  const fields = waiting.fields ?? [];
  const [values, setValues] = useState<Record<string, unknown>>(() => fieldDefaults(fields));
  const missing = fields.filter((field) => field.required && (values[field.key] === '' || values[field.key] == null));
  return (
    <div className="card pad flow-step" style={{ marginTop: 8 }}>
      <div className="row" style={{ gap: 6, marginBottom: 8 }}><Hourglass size={14} color={C.rose} /><strong style={{ fontSize: 13 }}>{waiting.title}</strong><span className="faint">{waiting.kind === 'form' ? '填写后继续' : '选择后继续'}</span></div>
      {waiting.kind === 'form' ? <>
        <InputForm fields={fields} values={values} onChange={setValues} />
        <button className="btn primary sm" disabled={busy || missing.length > 0} onClick={() => onSubmit(values, fields.map((field) => `${field.label}：${values[field.key] === true ? '是' : values[field.key] === false ? '否' : String(values[field.key] ?? '')}`).join('\n'))}>提交</button>
      </> : (
        <div className="row wrap" style={{ gap: 6 }}>{(waiting.options ?? []).map((option, index) => <button key={option} className={`btn sm ${index === 0 ? 'primary' : ''}`} disabled={busy} onClick={() => onSubmit({ choice: option }, option)}>{option}</button>)}</div>
      )}
    </div>
  );
}

export function ChatPanel({ appId, manifest, mode, shareToken, title, initialConversation, onConversation, beforeSend, onFlow }: {
  appId: string;
  /** 调试模式下在发送前保存草稿，确保预览运行的是最新配置。 */
  beforeSend?: () => Promise<void>;
  manifest: AppManifest;
  mode: ChatMode;
  shareToken?: string;
  title?: ReactNode;
  initialConversation?: { id: string; messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; citations: Citation[]; flow_waiting?: FlowWaiting | null }> } | null;
  onConversation?: (id: string) => void;
  /** Chat Flow 每次运行后回传节点状态，编排画布据此高亮执行路径 */
  onFlow?: (flow: FlowRun | null) => void;
}) {
  const toast = useToast();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [input, setInput] = useState('');
  const [values, setValues] = useState<Record<string, unknown>>(() => defaults(manifest));
  const [formOpen, setFormOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [cite, setCite] = useState<Citation | null>(null);
  const [rated, setRated] = useState<Record<string, 1 | -1>>({});
  const scroller = useRef<HTMLDivElement>(null);
  const form = needsForm(manifest);
  const debug = mode === 'debug';

  useEffect(() => {
    if (!initialConversation) return;
    setConversationId(initialConversation.id);
    setMsgs(initialConversation.messages.map((item) => ({ id: item.id, role: item.role === 'assistant' ? 'bot' : 'user', content: item.content, citations: item.citations, messageId: item.role === 'assistant' ? item.id : undefined, waiting: item.flow_waiting ?? null })));
  }, [initialConversation]);

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight }); }, [msgs]);

  // 调试时增删表单字段：保留已填的值，为新字段补默认值，不打断当前对话
  const fieldKeys = manifest.input_fields.map((field) => field.key).join(',');
  useEffect(() => {
    setValues((current) => {
      const next: Record<string, unknown> = defaults(manifest);
      for (const key of Object.keys(next)) if (key in current) next[key] = current[key];
      return next;
    });
  }, [fieldKeys]);

  /** confirmFor：确认副作用工具后，原地替换那条「待确认」回复，避免重复执行。 */
  const execute = async (message: string, inputs: Record<string, unknown>, confirmed: string[] = [], confirmFor?: string, resume?: RunPayload['resume']) => {
    const botId = confirmFor ?? crypto.randomUUID();
    const placeholder: Msg = { id: botId, role: 'bot', content: '', pending: true, request: { message, inputs } };
    setMsgs((current) => (confirmFor ? current.map((item) => (item.id === confirmFor ? placeholder : item)) : [...current, placeholder]));
    setBusy(true);
    const payload: RunPayload = { message, input_values: inputs, conversation_id: conversationId, confirmed_tool_names: confirmed, resume };
    try {
      await beforeSend?.();
      const result = mode === 'share' && shareToken ? await fdeApi.runShare(shareToken, payload) : mode === 'debug' ? await fdeApi.preview(appId, payload) : await fdeApi.run(appId, payload);
      setConversationId(result.conversation_id);
      onConversation?.(result.conversation_id);
      setMsgs((current) => current.map((item) => (item.id === botId ? {
        ...item, pending: false, content: result.content, steps: result.agent_steps, citations: result.citations, handoff: result.handoff,
        messageId: result.message_id, traceId: result.trace_id, waiting: result.flow?.waiting ?? null,
        meta: { tokens: result.tokens.total, duration: result.duration_ms, model: result.model?.display_name, simulated: result.simulated },
      } : item)));
      if (result.flow) onFlow?.(result.flow);
      return true;
    } catch (caught) {
      setMsgs((current) => current.map((item) => (item.id === botId ? { ...item, pending: false, error: errorMessage(caught), traceId: caught instanceof ApiError ? caught.traceId : undefined } : item)));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const send = (text: string) => {
    if (busy) return;
    if (!manifest.llm_model_id) {
      toast(debug ? '请先在左侧「模型与提示词」中选择对话模型' : '应用还没有配置对话模型，请联系管理员', 'error');
      return;
    }
    const message = text.trim();
    if (!message && !form) return;
    const inputs = inputsForMessage(manifest, message, values);
    const missing = manifest.input_fields.filter((field) => field.required && (inputs[field.key] === '' || inputs[field.key] == null));
    if (missing.length) {
      setFormOpen(true);
      toast(`请填写：${missing.map((field) => field.label).join('、')}`, 'error');
      return;
    }
    const shown = message || manifest.input_fields.filter((field) => inputs[field.key] !== '' && inputs[field.key] != null).map((field) => `${field.label}：${String(inputs[field.key])}`).join('\n');
    setMsgs((current) => [...current, { id: crypto.randomUUID(), role: 'user', content: shown }]);
    setInput('');
    if (form) setFormOpen(false);
    void execute(message, inputs);
  };

  const resume = (target: Msg, submitted: Record<string, unknown>, summary: string) => {
    if (busy || !target.messageId) return;
    setMsgs((current) => [...current.map((item) => (item.id === target.id ? { ...item, waiting: null } : item)), { id: crypto.randomUUID(), role: 'user', content: summary }]);
    // 提交被拒（如必填项缺失）时恢复这一步，用户改完可以再次提交
    void execute('', {}, [], undefined, { message_id: target.messageId, values: submitted }).then((ok) => {
      if (!ok) setMsgs((current) => current.map((item) => (item.id === target.id ? { ...item, waiting: target.waiting } : item)));
    });
  };

  const reset = () => { setMsgs([]); setConversationId(undefined); setValues(defaults(manifest)); setFormOpen(true); onFlow?.(null); };
  const feedback = async (messageId: string, rating: 1 | -1) => {
    try {
      await fdeApi.feedback(messageId, rating);
      setRated((current) => ({ ...current, [messageId]: rating }));
      toast(rating > 0 ? '感谢反馈' : '已记录，问题会进入运营复盘');
    } catch (caught) { toast(errorMessage(caught), 'error'); }
  };

  const opening = manifest.experience?.opening;
  const suggestions = manifest.experience?.suggestions ?? [];

  return (
    <div className="chat">
      {title !== undefined ? (
        <div className="row" style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
          {title}<span className="grow" />
          {conversationId && debug ? <span className="faint">会话 {conversationId.slice(0, 8)}</span> : null}
          <button className="btn ghost sm" onClick={reset}><RotateCcw size={14} />新对话</button>
        </div>
      ) : null}
      <div className="chat-scroll" ref={scroller} aria-live="polite">
        {opening || !msgs.length ? (
          <div className="msg"><span className="who" style={{ background: 'transparent' }}><AppTile templateKey={manifest.template_key} type={manifest.type} size="sm" /></span>
            <div><div className="bubble">{opening || `你好，我是「${manifest.name}」。${manifest.description}`}</div>
              {suggestions.length && !msgs.length ? <div className="suggest" style={{ marginTop: 10 }}>{suggestions.map((item) => <button key={item} onClick={() => send(item)}>{item}</button>)}</div> : null}
            </div>
          </div>
        ) : null}
        {msgs.map((m) => m.role === 'user' ? (
          <div key={m.id} className="msg user"><span className="who" style={{ background: C.avatarBg, color: C.avatarText, fontSize: 13, fontWeight: 600 }}>我</span><div className="bubble">{m.content}</div></div>
        ) : (
          <div key={m.id} className="msg">
            <span className="who" style={{ background: 'transparent' }}><AppTile templateKey={manifest.template_key} type={manifest.type} size="sm" /></span>
            <div style={{ maxWidth: 'min(720px, 88%)', minWidth: 0 }}>
              {m.steps?.length && (debug || manifest.agent.show_tool_steps) ? <StepsView steps={m.steps} open={debug} /> : null}
              <div className="bubble" style={{ maxWidth: '100%', whiteSpace: 'normal', borderColor: m.error ? C.dangerSoft : undefined, background: m.error ? 'var(--red-50)' : undefined }}>
                {m.pending ? <span className="row muted"><Spinner size={14} />{manifest.type === 'agent' ? '正在思考并调用工具…' : manifest.type === 'chatflow' ? '正在执行流程…' : '正在生成…'}</span> : null}
                {m.error ? <span className="row" style={{ color: C.dangerText, alignItems: 'flex-start' }}><CircleAlert size={15} style={{ flex: 'none', marginTop: 3 }} /><span>{m.error}</span></span> : null}
                {m.content ? <Markdown text={m.content} /> : null}
                {m.citations?.length ? (
                  <div className="msg-meta" style={{ borderTop: '1px dashed var(--border)', paddingTop: 8 }}>
                    <span className="faint">引用</span>
                    {m.citations.map((item, index) => <button key={`${item.chunk_id}-${index}`} className="cite" onClick={() => setCite(item)}>[{index + 1}] {item.filename}</button>)}
                  </div>
                ) : null}
              </div>
              {m.waiting && !m.pending ? <FlowStep waiting={m.waiting} busy={busy} onSubmit={(submitted, summary) => resume(m, submitted, summary)} /> : null}
              {m.steps?.some((step) => step.status === 'confirmation_required') && m.request ? (
                <div className="notice warn" style={{ marginTop: 6 }}>
                  <ShieldQuestion size={16} />
                  <span className="grow">以下操作会修改外部系统，需要你确认后执行：{m.steps.filter((step) => step.status === 'confirmation_required').map(STEP_LABEL).join('、')}</span>
                  <button className="btn sm primary" disabled={busy} onClick={() => void execute(m.request!.message, m.request!.inputs, m.steps!.filter((step) => step.status === 'confirmation_required').map((step) => step.tool), m.id)}>确认执行</button>
                </div>
              ) : null}
              {!m.pending ? (
                <div className="row wrap" style={{ marginTop: 6, gap: 2 }}>
                  {m.handoff ? <Tag tone="orange"><Headset size={12} />已转人工</Tag> : null}
                  {m.messageId && !m.error ? <>
                    <button className="btn ghost sm icon" aria-label="有帮助" onClick={() => void feedback(m.messageId!, 1)}><ThumbsUp size={14} color={rated[m.messageId] === 1 ? C.primary : undefined} /></button>
                    <button className="btn ghost sm icon" aria-label="没帮助" onClick={() => void feedback(m.messageId!, -1)}><ThumbsDown size={14} color={rated[m.messageId] === -1 ? C.danger : undefined} /></button>
                  </> : null}
                  {debug && m.meta ? <span className="faint" style={{ marginLeft: 6 }}>{m.meta.model} · {m.meta.tokens ?? '—'} tokens · {formatDuration(m.meta.duration)}{m.meta.simulated ? ' · 测试替身' : ''}</span> : null}
                  {debug && m.traceId ? <Link className="btn ghost sm" to={`/observability?view=runs&trace=${m.traceId}`}><Activity size={13} />查看 Trace</Link> : null}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
      {form ? (
        <div style={{ margin: '0 20px', borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          <button className="btn ghost sm" onClick={() => setFormOpen(!formOpen)}>{formOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}业务输入</button>
          {formOpen ? <div style={{ maxHeight: 280, overflow: 'auto', paddingTop: 8 }}><InputForm fields={manifest.input_fields} values={values} onChange={setValues} /></div> : null}
        </div>
      ) : null}
      {debug && !manifest.llm_model_id ? <div style={{ margin: '0 20px 8px' }}><Notice tone="warn">还没有选择对话模型，选择后才能调试。</Notice></div> : null}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); send(input); }}>
        <textarea rows={1} aria-label="输入消息" value={input} placeholder={debug ? '输入问题调试当前草稿（不影响线上）' : form ? '可补充说明，或直接发送表单' : '输入你的问题，Enter 发送，Shift+Enter 换行'} onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(input); } }} />
        <button className="btn primary icon" disabled={busy || (!input.trim() && !form)} aria-label="发送">{busy ? <Spinner size={14} /> : <Send size={15} />}</button>
      </form>
      <Drawer open={!!cite} title="引用来源" onClose={() => setCite(null)}>
        {cite ? <div className="col" style={{ gap: 12 }}>
          <strong>{cite.filename}</strong>
          <div className="faint">{cite.title}{cite.page_number ? ` · 第 ${cite.page_number} 页` : ''} · 相关度 {cite.score.toFixed(3)}</div>
          <div className="chunk-card"><div className="body">{cite.content}</div></div>
          {cite.knowledge_base_id && mode !== 'share' ? <Link className="btn" style={{ alignSelf: 'flex-start' }} to={`/knowledge/${cite.knowledge_base_id}`}>在知识库中查看</Link> : null}
        </div> : null}
      </Drawer>
    </div>
  );
}
