import { Bot, BookOpen, ChevronDown, Database, FormInput, Headset, MessageSquareText, Plus, Settings2, Shield, Trash2, Wrench, X } from 'lucide-react';
import { useEffect, useRef, useState, type PropsWithChildren, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ApiKnowledgeBase, ApiModelOption, ApiToolConfig } from '../api/client';
import type { AppManifest, AppTemplate, InputField } from '../api/fde';
import { Field, Modal, Notice, Slider, Switch, Tag } from '../components/ui';
import { retrievalConfig, SCENES, TYPE_META, withRetrievalConfig } from '../lib/apps';
import { C } from '../theme';

type Patch = (patch: Partial<AppManifest>) => void;

function Section({ icon, title, extra, children, defaultOpen = true }: PropsWithChildren<{ icon: ReactNode; title: ReactNode; extra?: ReactNode; defaultOpen?: boolean }>) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section style={{ borderBottom: '1px solid var(--border)', padding: '14px 0' }}>
      <div className="row">
        <button type="button" className="row grow" style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', textAlign: 'left' }} aria-expanded={open} onClick={() => setOpen(!open)}>
          <span style={{ color: 'var(--primary)', display: 'flex' }}>{icon}</span>
          <strong className="grow">{title}</strong>
        </button>
        {extra}
        <ChevronDown size={15} className="muted" style={{ transform: open ? 'none' : 'rotate(-90deg)', transition: 'transform .15s' }} />
      </div>
      {open ? <div style={{ marginTop: 12 }}>{children}</div> : null}
    </section>
  );
}

function ListEditor({ items, placeholder, onChange, max = 20 }: { items: string[]; placeholder: string; onChange: (items: string[]) => void; max?: number }) {
  const [value, setValue] = useState('');
  const add = () => { const text = value.trim(); if (text && !items.includes(text) && items.length < max) { onChange([...items, text]); setValue(''); } };
  return (
    <div className="col" style={{ gap: 6 }}>
      {items.map((item) => <div key={item} className="row" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '6px 10px' }}><span className="grow">{item}</span><button type="button" className="btn ghost sm icon" aria-label={`删除 ${item}`} onClick={() => onChange(items.filter((entry) => entry !== item))}><X size={13} /></button></div>)}
      <div className="row"><input className="input sm" value={value} placeholder={placeholder} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} /><button type="button" className="btn sm" disabled={!value.trim() || items.length >= max} onClick={add}>添加</button></div>
    </div>
  );
}

function toolRefName(tool: ApiToolConfig) {
  return `tool_${tool.id.replace(/-/g, '').slice(0, 10)}`;
}

const FIELD_TYPES: Record<InputField['type'], string> = { text: '单行文本', textarea: '多行文本', number: '数字', select: '下拉选择', boolean: '开关' };

function FieldEditor({ fields, onChange }: { fields: InputField[]; onChange: (fields: InputField[], renamed?: { from: string; to: string }) => void }) {
  const [editing, setEditing] = useState<{ index: number; field: InputField } | null>(null);
  const keyValid = editing ? /^[a-z][a-z0-9_]*$/.test(editing.field.key) && !fields.some((item, index) => item.key === editing.field.key && index !== editing.index) : true;
  const save = () => {
    if (!editing) return;
    const next = [...fields];
    if (editing.index < 0) next.push(editing.field); else next[editing.index] = editing.field;
    const previous = editing.index >= 0 ? fields[editing.index].key : null;
    onChange(next, previous && previous !== editing.field.key ? { from: previous, to: editing.field.key } : undefined);
    setEditing(null);
  };
  return (
    <>
      {fields.length ? (
        <table className="table" style={{ fontSize: 13 }}>
          <thead><tr><th>变量</th><th>名称</th><th>类型</th><th>必填</th><th /></tr></thead>
          <tbody>{fields.map((field, index) => (
            <tr key={field.key} className="clickable" onClick={() => setEditing({ index, field: { ...field } })}>
              <td className="mono">{field.key}</td><td>{field.label}</td><td><Tag>{FIELD_TYPES[field.type]}</Tag></td><td>{field.required ? '是' : '否'}</td>
              <td><button type="button" className="btn ghost sm icon" aria-label={`删除字段 ${field.label}`} onClick={(event) => { event.stopPropagation(); onChange(fields.filter((_, i) => i !== index)); }}><Trash2 size={13} /></button></td>
            </tr>
          ))}</tbody>
        </table>
      ) : <p className="faint">未配置表单，用户直接对话。</p>}
      <button type="button" className="btn sm" style={{ marginTop: 8 }} onClick={() => setEditing({ index: -1, field: { key: `field_${fields.length + 1}`, label: '', type: 'text', required: true, options: [], placeholder: '', description: '' } })}><Plus size={13} />添加字段</button>
      <Modal open={!!editing} title={editing && editing.index >= 0 ? '编辑字段' : '添加字段'} onClose={() => setEditing(null)}
        footer={<><button className="btn" onClick={() => setEditing(null)}>取消</button><button className="btn primary" disabled={!editing?.field.label.trim() || !keyValid || (editing?.field.type === 'select' && !editing.field.options.length)} onClick={save}>确定</button></>}>
        {editing ? <>
          <div className="form-grid">
            <Field label="显示名称" required><input className="input" value={editing.field.label} onChange={(event) => setEditing({ ...editing, field: { ...editing.field, label: event.target.value } })} /></Field>
            <Field label="变量名" required hint="小写字母开头"><input className="input mono" value={editing.field.key} onChange={(event) => setEditing({ ...editing, field: { ...editing.field, key: event.target.value } })} /></Field>
            <Field label="类型"><select className="select" value={editing.field.type} onChange={(event) => setEditing({ ...editing, field: { ...editing.field, type: event.target.value as InputField['type'], options: event.target.value === 'select' ? editing.field.options : [], default: null } })}>{Object.entries(FIELD_TYPES).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
            <Field label="必填"><Switch on={editing.field.required} onChange={(value) => setEditing({ ...editing, field: { ...editing.field, required: value } })} label="必填" /></Field>
          </div>
          {!keyValid ? <Notice tone="error">变量名需小写字母开头、仅含小写字母数字下划线，且不能重复。</Notice> : null}
          <Field label="说明" hint="显示在输入框旁"><input className="input" value={editing.field.description ?? ''} onChange={(event) => setEditing({ ...editing, field: { ...editing.field, description: event.target.value } })} /></Field>
          {editing.index >= 0 && editing.field.key !== fields[editing.index].key ? <Notice tone="info">提示词中的 {`{{${fields[editing.index].key}}}`} 会同步改为 {`{{${editing.field.key}}}`}。</Notice> : null}
          <Field label="占位提示"><input className="input" value={editing.field.placeholder ?? ''} onChange={(event) => setEditing({ ...editing, field: { ...editing.field, placeholder: event.target.value } })} /></Field>
          {editing.field.type === 'select' ? <Field label="选项" required><ListEditor items={editing.field.options} placeholder="添加选项" onChange={(options) => setEditing({ ...editing, field: { ...editing.field, options } })} /></Field> : null}
        </> : null}
      </Modal>
    </>
  );
}

/** 系统提示词：点「插入变量」或输入 {{ 时弹出表单字段，选中后插入到光标处。 */
function PromptEditor({ value, fields, onChange, variables = true }: { value: string; fields: InputField[]; onChange: (value: string) => void; variables?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<{ query: string; typed: boolean } | null>(null);
  const caret = useRef<number | null>(null);
  useEffect(() => {
    if (caret.current == null || !ref.current) return;
    ref.current.focus();
    ref.current.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [value]);

  const insert = (key: string) => {
    const el = ref.current;
    const end = el ? el.selectionEnd : value.length;
    // 通过输入 {{ 触发时，替换掉已经敲出的 {{ 和部分变量名
    const start = menu?.typed ? value.lastIndexOf('{{', end) : el ? el.selectionStart : value.length;
    const token = `{{${key}}}`;
    caret.current = start + token.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    setMenu(null);
  };
  const detect = (text: string, position: number) => {
    const match = /\{\{([a-z0-9_]*)$/.exec(text.slice(0, position));
    setMenu(match && fields.length ? { query: match[1], typed: true } : null);
  };
  const options = fields.filter((field) => !menu?.query || field.key.includes(menu.query) || field.label.includes(menu.query));

  return (
    <div style={{ position: 'relative' }}>
      <textarea ref={ref} className="textarea" style={{ minHeight: 220, fontSize: 13 }} value={value}
        onChange={(event) => { onChange(event.target.value); detect(event.target.value, event.target.selectionStart); }}
        onKeyDown={(event) => { if (event.key === 'Escape' && menu) { event.preventDefault(); setMenu(null); } if (event.key === 'Enter' && menu && options.length) { event.preventDefault(); insert(options[0].key); } }}
        onBlur={() => window.setTimeout(() => setMenu(null), 150)} />
      {variables ? <div className="row wrap" style={{ marginTop: 6, gap: 4 }}>
        <button type="button" className="btn sm" disabled={!fields.length} title={fields.length ? undefined : '先在「表单输入」中添加字段'} onClick={() => setMenu(menu ? null : { query: '', typed: false })}><Plus size={13} />插入变量</button>
        {fields.map((field) => <button type="button" key={field.key} className="tag mono" style={{ cursor: 'pointer' }} title={`插入 ${field.label}`} onMouseDown={(event) => event.preventDefault()} onClick={() => insert(field.key)}>{`{{${field.key}}}`}</button>)}
        {!fields.length ? <span className="faint">在下方「表单输入」添加字段后可在此引用</span> : null}
      </div> : null}
      {menu && options.length ? (
        <div className="card" role="listbox" style={{ position: 'absolute', left: 0, top: menu.typed ? 'calc(100% - 34px)' : '100%', zIndex: 20, minWidth: 240, padding: 4, boxShadow: 'var(--shadow-lg)' }}>
          {options.map((field) => (
            <button type="button" key={field.key} role="option" aria-selected={false} className="sub-link" onMouseDown={(event) => event.preventDefault()} onClick={() => insert(field.key)}>
              <span className="mono">{`{{${field.key}}}`}</span><span className="faint">{field.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function AppConfigForm({ manifest, patch, templates, models, knowledge, tools }: {
  manifest: AppManifest;
  patch: Patch;
  templates: AppTemplate[];
  models: ApiModelOption[];
  knowledge: ApiKnowledgeBase[];
  tools: ApiToolConfig[];
}) {
  const [kbOpen, setKbOpen] = useState(false);
  const [toolOpen, setToolOpen] = useState(false);
  const [retrievalOpen, setRetrievalOpen] = useState(false);
  const llms = models.filter((item) => item.model_type === 'llm' && item.is_enabled);
  const retrieval = retrievalConfig(manifest);
  const isAgent = manifest.type === 'agent';
  const externalTools = manifest.tools.filter((tool) => tool.tool_id);
  const template = templates.find((item) => item.key === manifest.template_key);
  const kbById = new Map(knowledge.map((item) => [item.id, item]));

  const toggleTool = (tool: ApiToolConfig) => {
    const exists = externalTools.some((item) => item.tool_id === tool.id);
    patch({ tools: exists ? manifest.tools.filter((item) => item.tool_id !== tool.id) : [...manifest.tools, { name: toolRefName(tool), tool_id: tool.id, enabled: true, config: {} }] });
  };

  return (
    <div>
      <Section icon={<Settings2 size={16} />} title="基础信息">
        <div className="form-grid">
          <Field label="应用名称" required><input className="input" value={manifest.name} onChange={(event) => patch({ name: event.target.value })} /></Field>
          <Field label="业务场景"><select className="select" value={manifest.template_key} onChange={(event) => patch({ template_key: event.target.value })}>{templates.map((item) => <option key={item.key} value={item.key}>{SCENES[item.key]?.name ?? item.name}</option>)}</select></Field>
        </div>
        <Field label="说明" hint="展示在工作台"><textarea className="textarea" style={{ minHeight: 56 }} value={manifest.description} onChange={(event) => patch({ description: event.target.value })} /></Field>
        <Field label="应用类型" hint="创建时确定，不可更改">
          <div className="row" style={{ gap: 8 }}><Tag tone={TYPE_META[manifest.type].tone}>{TYPE_META[manifest.type].name}</Tag><span className="faint">{TYPE_META[manifest.type].desc}</span></div>
        </Field>
      </Section>

      <Section icon={<Bot size={16} />} title="模型与提示词">
        <Field label="对话模型" required hint={isAgent ? '需支持工具调用' : undefined}>
          <select className="select" value={manifest.llm_model_id ?? ''} onChange={(event) => patch({ llm_model_id: event.target.value || null })}>
            <option value="">请选择</option>
            {llms.map((item) => <option key={item.id} value={item.id}>{item.display_name} · {item.provider}{item.provider === 'mock' ? '（测试替身）' : ''}{item.connection_status === 'error' ? '（连接异常）' : ''}</option>)}
          </select>
        </Field>
        <div className="form-grid">
          <Field label="温度" hint="越低越稳定"><Slider label="温度" value={manifest.model.temperature} min={0} max={1.5} step={0.1} onChange={(value) => patch({ model: { ...manifest.model, temperature: value } })} /></Field>
          <Field label="回复上限" hint="tokens"><Slider label="回复上限" value={manifest.model.max_tokens} min={256} max={16384} step={256} onChange={(value) => patch({ model: { ...manifest.model, max_tokens: value } })} /></Field>
        </div>
        <Field label={isAgent ? '角色与工作方式' : '系统提示词'} hint={isAgent ? '写清楚何时检索、何时用哪个工具、何时转人工' : '可引用表单变量'}>
          <PromptEditor value={manifest.system_prompt} fields={manifest.input_fields} variables={!isAgent} onChange={(system_prompt) => patch({ system_prompt })} />
        </Field>
      </Section>

      <Section icon={<BookOpen size={16} />} title="知识库" extra={<Tag>{manifest.knowledge_base_ids.length} 个</Tag>}>
        {template?.knowledge_bases.required && !manifest.knowledge_base_ids.length ? <div style={{ marginBottom: 8 }}><Notice tone="warn">「{template.name}」场景需要至少关联一个知识库才能发布。</Notice></div> : null}
        <div className="col" style={{ gap: 6 }}>
          {manifest.knowledge_base_ids.map((id) => {
            const kb = kbById.get(id);
            return (
              <div key={id} className="row" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
                <span className="avatar-tile sm" style={{ background: C.success }}><Database size={14} /></span>
                <span className="grow">{kb ? <Link to={`/knowledge/${id}`}>{kb.name}</Link> : '已删除的知识库'}<span className="faint"> · {kb?.chunk_count ?? 0} 块</span></span>
                <button type="button" className="btn ghost sm icon" aria-label="移除知识库" onClick={() => patch({ knowledge_base_ids: manifest.knowledge_base_ids.filter((item) => item !== id) })}><X size={14} /></button>
              </div>
            );
          })}
          <div className="row">
            <button type="button" className="btn sm" onClick={() => setKbOpen(true)}><Plus size={13} />关联知识库</button>
            <button type="button" className="btn sm ghost" onClick={() => setRetrievalOpen(true)}><Settings2 size={13} />检索参数</button>
            <span className="grow" /><span className="faint">{({ semantic: '语义', fulltext: '全文', hybrid: '混合' } as const)[retrieval.mode]}检索 · Top {retrieval.top_k} · 阈值 {retrieval.score_threshold}</span>
          </div>
          {isAgent && manifest.knowledge_base_ids.length ? (
            <Field label="Agent 如何使用知识库">
              <div className="seg">
                <button type="button" className={manifest.agent.knowledge_mode === 'tool' ? 'active' : ''} onClick={() => patch({ agent: { ...manifest.agent, knowledge_mode: 'tool' } })}>作为工具，由 Agent 决定</button>
                <button type="button" className={manifest.agent.knowledge_mode === 'always' ? 'active' : ''} onClick={() => patch({ agent: { ...manifest.agent, knowledge_mode: 'always' } })}>每轮先检索</button>
              </div>
              <p className="faint" style={{ marginTop: 6 }}>{manifest.agent.knowledge_mode === 'tool' ? 'Agent 自行改写检索问题、可多次检索；闲聊和纯工具类问题不会触发检索。' : '每轮用用户原话检索后再交给 Agent，行为更可预测。'}</p>
            </Field>
          ) : null}
        </div>
      </Section>

      {isAgent ? (
        <Section icon={<Wrench size={16} />} title="工具" extra={<button type="button" className="btn sm" onClick={() => setToolOpen(true)}><Plus size={13} />添加</button>}>
          <div className="col" style={{ gap: 8 }}>
            {externalTools.map((reference) => {
              const tool = tools.find((item) => item.id === reference.tool_id);
              return (
                <div key={reference.tool_id} className="row" style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px' }}>
                  <span className="avatar-tile sm" style={{ background: C.primary }}><Wrench size={14} /></span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 6 }}><strong style={{ fontSize: 13 }}>{tool?.name ?? '已删除的工具'}</strong><Tag>HTTP</Tag>{tool?.config.side_effect ? <Tag tone="orange">有副作用</Tag> : null}{tool && !tool.is_enabled ? <Tag tone="red">已停用</Tag> : null}</div>
                    <div className="faint ellipsis">{tool?.description}</div>
                  </div>
                  <button type="button" className="btn ghost sm icon" aria-label="移除工具" onClick={() => patch({ tools: manifest.tools.filter((item) => item.tool_id !== reference.tool_id) })}><X size={14} /></button>
                </div>
              );
            })}
            <div className="row" style={{ border: '1px dashed var(--border-strong)', borderRadius: 10, padding: '10px 12px', background: 'var(--orange-50)' }}>
              <span className="avatar-tile sm" style={{ background: C.warning }}><Headset size={14} /></span>
              <div className="grow"><strong style={{ fontSize: 13 }}>转人工</strong> <Tag tone="orange">内置</Tag><div className="faint">用户要求人工、投诉赔偿或无法解决时，Agent 可调用转接</div></div>
              <Switch on={manifest.guardrails.human_handoff} onChange={(value) => patch({ guardrails: { ...manifest.guardrails, human_handoff: value } })} label="转人工" />
            </div>
            {!tools.length ? <p className="faint">还没有可用的业务工具，管理员可在「集成 → 业务工具」中接入 HTTP 接口。</p> : null}
          </div>
          <div className="divider" />
          <Field label="单轮最多推理步数"><Slider label="最大步数" value={manifest.agent.max_steps} min={1} max={20} onChange={(value) => patch({ agent: { ...manifest.agent, max_steps: value } })} /></Field>
          <div className="col" style={{ gap: 10 }}>
            <div className="row"><span className="grow">有副作用的工具需用户确认<div className="faint">如创建工单、修改订单</div></span><Switch on={manifest.agent.require_confirmation_for_side_effects} onChange={(value) => patch({ agent: { ...manifest.agent, require_confirmation_for_side_effects: value } })} label="需确认" /></div>
            <div className="row"><span className="grow">向用户展示工具调用过程</span><Switch on={manifest.agent.show_tool_steps} onChange={(value) => patch({ agent: { ...manifest.agent, show_tool_steps: value } })} label="展示过程" /></div>
          </div>
        </Section>
      ) : (
        <Section icon={<FormInput size={16} />} title="表单输入" extra={<Tag>{manifest.input_fields.length} 个字段</Tag>}>
          <FieldEditor fields={manifest.input_fields} onChange={(fields, renamed) => patch({
            input_fields: fields,
            ...(renamed ? { system_prompt: manifest.system_prompt.split(`{{${renamed.from}}}`).join(`{{${renamed.to}}}`) } : {}),
          })} />
        </Section>
      )}

      <Section icon={<MessageSquareText size={16} />} title="对话体验" defaultOpen={false}>
        <Field label="开场白"><textarea className="textarea" style={{ minHeight: 60 }} value={manifest.experience.opening} placeholder="用户进入时看到的第一句话" onChange={(event) => patch({ experience: { ...manifest.experience, opening: event.target.value } })} /></Field>
        <Field label="猜你想问" hint="最多 8 个"><ListEditor items={manifest.experience.suggestions} max={8} placeholder="添加一个推荐问题" onChange={(suggestions) => patch({ experience: { ...manifest.experience, suggestions } })} /></Field>
        <div className="col" style={{ gap: 10 }}>
          <div className="row"><span className="grow">多轮记忆<div className="faint">携带最近 {manifest.memory.max_turns} 轮对话</div></span><Switch on={manifest.memory.enabled} onChange={(value) => patch({ memory: { ...manifest.memory, enabled: value } })} label="多轮记忆" /></div>
          {manifest.memory.enabled ? <Field label="携带轮数"><Slider label="携带轮数" value={manifest.memory.max_turns} min={1} max={50} onChange={(value) => patch({ memory: { ...manifest.memory, max_turns: value } })} /></Field> : null}
          {!isAgent ? <div className="row"><span className="grow">输出格式</span><select className="select sm" style={{ width: 140 }} value={manifest.output.format} onChange={(event) => patch({ output: { ...manifest.output, format: event.target.value as AppManifest['output']['format'], json_schema: event.target.value === 'json' ? manifest.output.json_schema ?? null : null } })}><option value="markdown">Markdown</option><option value="text">纯文本</option><option value="json">JSON</option></select></div> : null}
        </div>
      </Section>

      <Section icon={<Shield size={16} />} title="安全与合规" defaultOpen={false}>
        <div className="col" style={{ gap: 10 }}>
          <div className="row"><span className="grow">回答必须附引用</span><Switch on={manifest.guardrails.require_citations} onChange={(value) => patch({ guardrails: { ...manifest.guardrails, require_citations: value } })} label="必须引用" /></div>
          <div className="row"><span className="grow">检索无依据时拒答<div className="faint">{isAgent && manifest.agent.knowledge_mode === 'tool' ? '工具模式下由提示词约束 Agent 行为' : '不调用模型，直接回复无依据'}</div></span><Switch on={manifest.guardrails.refuse_without_evidence} onChange={(value) => patch({ guardrails: { ...manifest.guardrails, refuse_without_evidence: value } })} label="拒答" /></div>
          {!isAgent ? <div className="row"><span className="grow">命中禁止话题时转人工</span><Switch on={manifest.guardrails.human_handoff} onChange={(value) => patch({ guardrails: { ...manifest.guardrails, human_handoff: value } })} label="转人工" /></div> : null}
          <Field label="禁止话题" hint="回答中出现即拦截"><ListEditor items={manifest.guardrails.blocked_topics} max={30} placeholder="例如：具体项目报价" onChange={(blocked_topics) => patch({ guardrails: { ...manifest.guardrails, blocked_topics } })} /></Field>
          <Field label="最大输出长度" hint="字"><Slider label="最大输出长度" value={manifest.guardrails.max_output_chars} min={100} max={50000} step={100} onChange={(value) => patch({ guardrails: { ...manifest.guardrails, max_output_chars: value } })} /></Field>
        </div>
      </Section>

      <Modal open={kbOpen} title="关联知识库" onClose={() => setKbOpen(false)} footer={<button className="btn primary" onClick={() => setKbOpen(false)}>完成</button>}>
        {!knowledge.length ? <p className="faint">还没有知识库，<Link to="/knowledge">去创建</Link>。</p> : null}
        <div className="col">
          {knowledge.map((kb) => {
            const on = manifest.knowledge_base_ids.includes(kb.id);
            return (
              <button type="button" key={kb.id} className={`method-card ${on ? 'active' : ''}`} style={{ alignItems: 'center' }} onClick={() => patch({ knowledge_base_ids: on ? manifest.knowledge_base_ids.filter((item) => item !== kb.id) : [...manifest.knowledge_base_ids, kb.id] })}>
                <span className="avatar-tile sm" style={{ background: C.success }}><Database size={14} /></span>
                <div className="grow"><h4>{kb.name}</h4><p>{kb.description || '暂无简介'} · {kb.file_count} 个文件 · {kb.chunk_count} 块{kb.embedding_model_id ? '' : ' · 仅支持全文检索'}</p></div>
                {on ? <Tag tone="blue">已选</Tag> : null}
              </button>
            );
          })}
        </div>
      </Modal>

      <Modal open={retrievalOpen} title="检索参数" onClose={() => setRetrievalOpen(false)} footer={<button className="btn primary" onClick={() => setRetrievalOpen(false)}>完成</button>}>
        <Field label="检索模式">
          <div className="seg">{([['semantic', '语义'], ['fulltext', '全文'], ['hybrid', '混合']] as const).map(([key, label]) => <button type="button" key={key} className={retrieval.mode === key ? 'active' : ''} onClick={() => patch(withRetrievalConfig(manifest, { mode: key }))}>{label}</button>)}</div>
          <p className="faint" style={{ marginTop: 6 }}>编号、型号、条款号类问题建议用混合检索。</p>
        </Field>
        <Field label="初召回数量"><Slider label="初召回数量" value={retrieval.top_k} min={1} max={50} onChange={(value) => patch(withRetrievalConfig(manifest, { top_k: value, rerank_top_n: Math.min(retrieval.rerank_top_n, value) }))} /></Field>
        <Field label="重排后保留" hint="知识库配置了重排模型时生效"><Slider label="重排后保留" value={retrieval.rerank_top_n} min={1} max={Math.min(20, retrieval.top_k)} onChange={(value) => patch(withRetrievalConfig(manifest, { rerank_top_n: value }))} /></Field>
        <Field label="最低相关度"><Slider label="最低相关度" value={retrieval.score_threshold} min={0} max={1} step={0.05} onChange={(value) => patch(withRetrievalConfig(manifest, { score_threshold: value }))} /></Field>
        <Field label="引用上限" hint="字符"><Slider label="引用上限" value={retrieval.max_context_chars} min={1000} max={50000} step={1000} onChange={(value) => patch(withRetrievalConfig(manifest, { max_context_chars: value }))} /></Field>
      </Modal>

      <Modal open={toolOpen} title="添加工具" onClose={() => setToolOpen(false)} wide footer={<><Link className="btn" to="/tools?tab=tools">管理工具库</Link><button className="btn primary" onClick={() => setToolOpen(false)}>完成</button></>}>
        {!tools.length ? <p className="faint">工具库为空。</p> : null}
        <div className="grid c2" style={{ gap: 10 }}>
          {tools.map((tool) => {
            const on = externalTools.some((item) => item.tool_id === tool.id);
            return (
              <button type="button" key={tool.id} disabled={!tool.is_enabled} className={`method-card ${on ? 'active' : ''}`} onClick={() => toggleTool(tool)}>
                <span className="avatar-tile sm" style={{ background: C.primary }}><Wrench size={14} /></span>
                <div className="grow"><h4>{tool.name}<Tag>{tool.config.method ?? 'HTTP'}</Tag>{tool.connection_status === 'connected' ? <Tag tone="green">已连通</Tag> : tool.connection_status === 'error' ? <Tag tone="red">测试失败</Tag> : null}</h4><p>{tool.description}</p></div>
                {on ? <Tag tone="blue">已添加</Tag> : null}
              </button>
            );
          })}
        </div>
      </Modal>
    </div>
  );
}
