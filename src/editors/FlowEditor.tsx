import '@xyflow/react/dist/style.css';
import {
  addEdge, applyEdgeChanges, applyNodeChanges, Background, BackgroundVariant, Controls, Handle, MiniMap, Panel, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Connection, type Edge, type EdgeChange, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react';
import { AlertTriangle, Bug, CheckCircle2, CircleAlert, Copy, Hourglass, Plus, Search, Settings2, Trash2, Variable, X } from 'lucide-react';
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { type ApiKnowledgeBase, type ApiModelOption, type ApiToolConfig } from '../api/client';
import { fdeApi, type AppManifest, type AppTemplate, type FDEApp, type FlowGraph, type FlowNodeKind, type FlowNodeSpec, type FlowRun, type InputField, type ValidationIssue } from '../api/fde';
import { ChatPanel } from '../components/ChatPanel';
import { Field, Slider, Switch, Tag, useToast } from '../components/ui';
import { BRANCH_KINDS, DEF, MODEL_KINDS, NODE_DEFS, OPERATORS, branchLabels, defaultConfig, nextNodeId, outputFields, upstreamIds } from '../flow/nodes';
import { C } from '../theme';
import { AppConfigForm, FieldEditor, ListEditor } from './AppConfigForm';

type Resources = { templates: AppTemplate[]; models: ApiModelOption[]; knowledge: ApiKnowledgeBase[]; tools: ApiToolConfig[] };
type FlowRFNode = Node<{ spec: FlowNodeSpec }, 'flow'>;
type PanelKey = 'node' | 'settings' | 'debug' | 'issues' | null;

const VAR = /\{\{\s*([A-Za-z][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_]+)*)\s*\}\}/g;
const MODES = { semantic: '语义', fulltext: '全文', hybrid: '混合' } as const;

const ViewContext = createContext<{ status: Record<string, string>; issueNodes: Set<string>; describe: (spec: FlowNodeSpec) => string[] }>({ status: {}, issueNodes: new Set(), describe: () => [] });

const firstLine = (text: string) => (text || '').split('\n').find((line) => line.trim())?.trim() ?? '';

// ---------------------------------------------------------------- 画布节点

const FlowCard = memo(function FlowCard({ data, selected }: NodeProps<FlowRFNode>) {
  const { spec } = data;
  const def = DEF[spec.kind];
  const view = useContext(ViewContext);
  const status = view.status[spec.id];
  const branches = BRANCH_KINDS.includes(spec.kind) ? branchLabels(spec) : null;
  const Icon = def.icon;
  const lines = view.describe(spec).filter(Boolean).slice(0, 3);
  return (
    <div className={`flow-node ${selected ? 'selected' : ''} ${status ? `is-${status}` : ''} ${view.issueNodes.has(spec.id) ? 'has-issue' : ''}`}>
      {spec.kind !== 'start' ? <Handle type="target" position={Position.Left} style={{ top: 22 }} /> : null}
      <div className="row" style={{ gap: 8 }}>
        <span className="avatar-tile sm" style={{ background: def.color, width: 24, height: 24 }}><Icon size={13} /></span>
        <strong className="grow ellipsis" style={{ fontSize: 13 }}>{spec.title}</strong>
        {status === 'success' ? <CheckCircle2 size={15} color={C.success} aria-label="已执行" /> : status === 'waiting' ? <Hourglass size={15} color={C.rose} aria-label="等待用户" /> : null}
        {view.issueNodes.has(spec.id) && !status ? <CircleAlert size={15} color={C.danger} aria-label="配置有问题" /> : null}
      </div>
      {lines.length ? <div className="flow-lines">{lines.map((line, index) => <div key={index} className="ellipsis">{line}</div>)}</div> : null}
      {branches ? (
        <div className="flow-branches">
          {branches.map((label, index) => (
            <div key={`${label}-${index}`} className="flow-branch">
              <span style={{ color: def.color, fontWeight: 600, marginRight: 6 }}>{spec.kind === 'ifelse' ? (index === 0 ? 'IF' : 'ELSE') : `#${index + 1}`}</span>{label}
              <Handle type="source" id={`b${index}`} position={Position.Right} style={{ right: -5 }} />
            </div>
          ))}
        </div>
      ) : spec.kind !== 'answer' ? <Handle type="source" position={Position.Right} style={{ top: 22 }} /> : null}
    </div>
  );
});

const nodeTypes = { flow: FlowCard };

const toNode = (spec: FlowNodeSpec): FlowRFNode => ({ id: spec.id, type: 'flow', position: spec.position, data: { spec }, deletable: spec.kind !== 'start' });
const toEdge = (edge: FlowGraph['edges'][number]): Edge => ({ id: edge.id, source: edge.source, target: edge.target, sourceHandle: edge.source_handle ?? null });
const edgeId = (source: string, handle: string | null | undefined, target: string) => `${source}-${handle ?? 'o'}-${target}`;

// ---------------------------------------------------------------- 变量输入

function refLabel(ref: string, path: string, graph: FlowGraph, manifest: AppManifest): { label: string; ok: boolean } {
  if (ref === 'item' || ref === 'index') return { label: ref === 'item' ? '当前项' : '序号', ok: true };
  const node = graph.nodes.find((item) => item.id === ref);
  if (!node) return { label: `{{${ref}${path}}}`, ok: false };
  const field = path.slice(1).split('.')[0];
  const known = outputFields(node, manifest).find(([key]) => key === field);
  return { label: `${node.title} · ${known?.[1] ?? field}${path.split('.').length > 2 ? path.slice(field.length + 1) : ''}`, ok: !!known };
}

/** 可插入上游节点变量的文本框：变量写成 {{节点ID.字段}}，下方显示它们对应的节点和字段名。 */
function TemplateInput({ value, onChange, graph, manifest, nodeId, rows = 4, single, loopVars, placeholder }: {
  value: string; onChange: (value: string) => void; graph: FlowGraph; manifest: AppManifest; nodeId: string; rows?: number; single?: boolean; loopVars?: boolean; placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const upstream = upstreamIds(graph, nodeId);
  const sources = graph.nodes.filter((node) => upstream.has(node.id)).sort((a, b) => a.position.x - b.position.x);
  const refs = [...(value || '').matchAll(VAR)].map((match) => ({ token: match[0], ...refLabel(match[1], match[2] ?? '', graph, manifest), upstream: upstream.has(match[1]) || ((match[1] === 'item' || match[1] === 'index') && !!loopVars) }));

  const insert = (token: string) => {
    const element = ref.current;
    const start = element?.selectionStart ?? value.length;
    const end = element?.selectionEnd ?? value.length;
    onChange(value.slice(0, start) + token + value.slice(end));
    setOpen(false);
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(start + token.length, start + token.length); });
  };

  return (
    <div style={{ position: 'relative' }}>
      {single
        ? <input ref={ref} className="input mono-ish" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
        : <textarea ref={ref} className="textarea" style={{ minHeight: rows * 22 }} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />}
      <div className="row wrap" style={{ gap: 4, marginTop: 4 }}>
        <button type="button" className="btn ghost sm" onClick={() => setOpen(!open)}><Variable size={13} />插入变量</button>
        {refs.map((item, index) => <Tag key={`${item.token}-${index}`} tone={item.ok && item.upstream ? 'blue' : 'red'} title={item.ok && item.upstream ? item.token : '引用的节点不在上游或字段不存在'}>{item.label}</Tag>)}
      </div>
      {open ? (
        <div className="card var-menu" role="menu">
          {loopVars ? <div className="var-group"><div className="faint">批量生成</div><button type="button" className="sub-link" onClick={() => insert('{{item}}')}>当前项 <span className="faint mono">item</span></button><button type="button" className="sub-link" onClick={() => insert('{{index}}')}>序号 <span className="faint mono">index</span></button></div> : null}
          {sources.map((node) => (
            <div key={node.id} className="var-group">
              <div className="faint">{node.title}</div>
              {outputFields(node, manifest).map(([key, label]) => <button key={key} type="button" className="sub-link" onClick={() => insert(`{{${node.id}.${key}}}`)}>{label} <span className="faint mono">{node.id}.{key}</span></button>)}
            </div>
          ))}
          {!sources.length && !loopVars ? <p className="faint" style={{ padding: 8 }}>先把上游节点连到这里，才能引用它们的输出。</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function ModelSelect({ value, models, onChange }: { value: string | null; models: ApiModelOption[]; onChange: (value: string | null) => void }) {
  const llms = models.filter((item) => item.model_type === 'llm' && item.is_enabled);
  return (
    <select className="select" value={value ?? ''} onChange={(event) => onChange(event.target.value || null)}>
      <option value="">跟随默认模型</option>
      {llms.map((item) => <option key={item.id} value={item.id}>{item.display_name}{item.provider === 'mock' ? '（测试替身）' : ''}</option>)}
    </select>
  );
}

// ---------------------------------------------------------------- 节点配置

function NodeConfig({ spec, graph, manifest, resources, onChange, onDelete, onDuplicate, onSettings, onClose }: {
  spec: FlowNodeSpec; graph: FlowGraph; manifest: AppManifest; resources: Resources;
  onChange: (spec: FlowNodeSpec) => void; onDelete: () => void; onDuplicate: () => void; onSettings: () => void; onClose: () => void;
}) {
  const def = DEF[spec.kind];
  const config = spec.config;
  const set = (patch: Record<string, unknown>) => onChange({ ...spec, config: { ...config, ...patch } });
  const io = { graph, manifest, nodeId: spec.id };
  const Icon = def.icon;
  const tool = spec.kind === 'tool' ? resources.tools.find((item) => item.id === config.tool_id) : undefined;
  const toolParams = (tool?.config.parameters as { properties?: Record<string, { description?: string }>; required?: string[] } | undefined) ?? {};

  let body: ReactNode = null;
  switch (spec.kind) {
    case 'start':
      body = <>
        <Field label="输出变量"><div className="col" style={{ gap: 4 }}>{outputFields(spec, manifest).map(([key, label]) => <div key={key} className="row"><Tag>{label}</Tag><span className="faint mono">start.{key}</span></div>)}</div></Field>
        <button className="btn sm" onClick={onSettings}><Settings2 size={13} />编辑开始表单与全局设置</button>
      </>;
      break;
    case 'llm':
      body = <>
        <Field label="模型"><ModelSelect value={config.model_id} models={resources.models} onChange={(model_id) => set({ model_id })} /></Field>
        <Field label="系统提示词" hint="可选，拼接在全局提示词之后"><TemplateInput {...io} rows={3} value={config.system_prompt} onChange={(system_prompt) => set({ system_prompt })} /></Field>
        <Field label="用户提示词" required><TemplateInput {...io} rows={6} value={config.prompt} onChange={(prompt) => set({ prompt })} /></Field>
        <div className="row"><span className="grow">携带对话历史<div className="faint">多轮追问时打开，按全局设置的轮数携带</div></span><Switch on={!!config.history} onChange={(history) => set({ history })} label="携带对话历史" /></div>
      </>;
      break;
    case 'kb':
      body = <>
        <Field label="知识库" required>
          <div className="col" style={{ gap: 4 }}>
            {resources.knowledge.map((kb) => (
              <label key={kb.id} className="row" style={{ gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={config.knowledge_base_ids.includes(kb.id)} onChange={(event) => set({ knowledge_base_ids: event.target.checked ? [...config.knowledge_base_ids, kb.id] : config.knowledge_base_ids.filter((id: string) => id !== kb.id) })} />
                <span className="grow">{kb.name}</span><span className="faint">{kb.chunk_count ?? 0} 块</span>
              </label>
            ))}
            {!resources.knowledge.length ? <p className="faint">还没有知识库，先在「知识库」里创建并导入资料。</p> : null}
          </div>
        </Field>
        <Field label="检索问题"><TemplateInput {...io} single value={config.query} onChange={(query) => set({ query })} /></Field>
        <Field label="检索模式"><div className="seg">{(Object.keys(MODES) as Array<keyof typeof MODES>).map((mode) => <button key={mode} type="button" className={config.mode === mode ? 'active' : ''} onClick={() => set({ mode })}>{MODES[mode]}</button>)}</div></Field>
        <div className="form-grid">
          <Field label="召回数量"><Slider label="召回数量" value={config.top_k} min={1} max={20} onChange={(top_k) => set({ top_k, rerank_top_n: Math.min(config.rerank_top_n, top_k) })} /></Field>
          <Field label="最低相关度"><Slider label="最低相关度" value={config.score_threshold} min={0} max={1} step={0.05} onChange={(score_threshold) => set({ score_threshold })} /></Field>
        </div>
        <Field label="引用上限" hint="字"><Slider label="引用上限" value={config.max_context_chars} min={1000} max={20000} step={1000} onChange={(max_context_chars) => set({ max_context_chars })} /></Field>
      </>;
      break;
    case 'classify':
      body = <>
        <Field label="模型"><ModelSelect value={config.model_id} models={resources.models} onChange={(model_id) => set({ model_id })} /></Field>
        <Field label="分类依据"><TemplateInput {...io} rows={2} value={config.input} onChange={(input) => set({ input })} /></Field>
        <Field label="分类" hint="每个分类是一个出口；最后一个建议设为「其他」兜底"><ListEditor items={config.categories} max={10} placeholder="新增分类" onChange={(categories) => set({ categories })} /></Field>
        <Field label="补充说明" hint="可选，帮助模型区分边界"><textarea className="textarea" style={{ minHeight: 56 }} value={config.instruction} onChange={(event) => set({ instruction: event.target.value })} /></Field>
      </>;
      break;
    case 'extract':
      body = <>
        <Field label="模型"><ModelSelect value={config.model_id} models={resources.models} onChange={(model_id) => set({ model_id })} /></Field>
        <Field label="提取来源"><TemplateInput {...io} rows={2} value={config.input} onChange={(input) => set({ input })} /></Field>
        <Field label="提取字段">
          <div className="col" style={{ gap: 6 }}>
            {(config.fields as Array<{ key: string; label: string; type: string; description: string }>).map((item, index) => {
              const update = (patch: Partial<typeof item>) => set({ fields: config.fields.map((entry: typeof item, i: number) => (i === index ? { ...entry, ...patch } : entry)) });
              return (
                <div key={index} className="row" style={{ gap: 4 }}>
                  <input className="input sm" style={{ flex: 1.2 }} aria-label="字段名称" placeholder="名称" value={item.label} onChange={(event) => update({ label: event.target.value })} />
                  <input className={`input sm mono ${/^[a-z][a-z0-9_]*$/.test(item.key) ? '' : 'invalid'}`} style={{ flex: 1 }} aria-label="变量名" placeholder="key" value={item.key} onChange={(event) => update({ key: event.target.value })} />
                  <select className="select sm" style={{ width: 76 }} aria-label="类型" value={item.type} onChange={(event) => update({ type: event.target.value })}><option value="string">文本</option><option value="number">数字</option><option value="boolean">是否</option><option value="list">列表</option></select>
                  <button type="button" className="btn ghost sm icon" aria-label={`删除字段 ${item.label}`} onClick={() => set({ fields: config.fields.filter((_: unknown, i: number) => i !== index) })}><X size={13} /></button>
                </div>
              );
            })}
            <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => set({ fields: [...config.fields, { key: `field_${config.fields.length + 1}`, label: '', type: 'string', description: '' }] })}><Plus size={13} />添加字段</button>
          </div>
        </Field>
      </>;
      break;
    case 'ifelse':
      body = <>
        {config.conditions.length > 1 ? <Field label="多个条件"><div className="seg"><button type="button" className={config.logic === 'and' ? 'active' : ''} onClick={() => set({ logic: 'and' })}>全部满足</button><button type="button" className={config.logic === 'or' ? 'active' : ''} onClick={() => set({ logic: 'or' })}>任一满足</button></div></Field> : null}
        <Field label="条件" hint="满足走 IF，否则走 ELSE">
          <div className="col" style={{ gap: 10 }}>
            {(config.conditions as Array<{ left: string; operator: string; right: string }>).map((item, index) => {
              const update = (patch: Partial<typeof item>) => set({ conditions: config.conditions.map((entry: typeof item, i: number) => (i === index ? { ...entry, ...patch } : entry)) });
              return (
                <div key={index} className="card pad" style={{ padding: 10, background: 'var(--bg-soft)' }}>
                  <TemplateInput {...io} single placeholder="比较对象，如 {{review.text}}" value={item.left} onChange={(left) => update({ left })} />
                  <div className="row" style={{ gap: 6, marginTop: 6 }}>
                    <select className="select sm" style={{ width: 110 }} aria-label="比较方式" value={item.operator} onChange={(event) => update({ operator: event.target.value })}>{Object.entries(OPERATORS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
                    {item.operator !== 'empty' && item.operator !== 'not_empty' ? <input className="input sm grow" aria-label="比较值" placeholder="值" value={item.right} onChange={(event) => update({ right: event.target.value })} /> : <span className="grow" />}
                    <button type="button" className="btn ghost sm icon" aria-label="删除条件" onClick={() => set({ conditions: config.conditions.filter((_: unknown, i: number) => i !== index) })}><X size={13} /></button>
                  </div>
                </div>
              );
            })}
            <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => set({ conditions: [...config.conditions, { left: '', operator: 'contains', right: '' }] })}><Plus size={13} />添加条件</button>
          </div>
        </Field>
      </>;
      break;
    case 'template':
    case 'answer':
      body = <Field label={spec.kind === 'answer' ? '回复内容' : '模板'} hint={spec.kind === 'answer' ? '多个回复节点按执行顺序拼接' : undefined}><TemplateInput {...io} rows={7} value={config.template} onChange={(template) => set({ template })} /></Field>;
      break;
    case 'loop':
      body = <>
        <Field label="逐项处理的列表" required hint="上游的列表，或多行文本（每行一项，自动去掉序号）"><TemplateInput {...io} single placeholder="如 {{outline.text}}" value={config.items} onChange={(items) => set({ items })} /></Field>
        <Field label="模型"><ModelSelect value={config.model_id} models={resources.models} onChange={(model_id) => set({ model_id })} /></Field>
        <Field label="每一项的提示词" required><TemplateInput {...io} loopVars rows={6} value={config.prompt} onChange={(prompt) => set({ prompt })} /></Field>
        <div className="form-grid">
          <Field label="最多处理"><Slider label="最多处理" value={config.max_items} min={1} max={30} suffix="项" onChange={(max_items) => set({ max_items })} /></Field>
          <Field label="并行数"><Slider label="并行数" value={config.parallel} min={1} max={5} onChange={(parallel) => set({ parallel })} /></Field>
        </div>
      </>;
      break;
    case 'form':
      body = <>
        <Field label="提示语" hint="显示在对话里"><input className="input" value={config.prompt} onChange={(event) => set({ prompt: event.target.value })} /></Field>
        <Field label="表单字段" hint="流程停在这里，用户提交后继续"><FieldEditor fields={config.fields as InputField[]} onChange={(fields) => set({ fields })} /></Field>
      </>;
      break;
    case 'choice':
      body = <>
        <Field label="展示给用户的内容"><TemplateInput {...io} rows={4} placeholder="如：大纲如下 {{outline.text}}，请确认" value={config.prompt} onChange={(prompt) => set({ prompt })} /></Field>
        <Field label="选项" hint="每个选项是一个出口"><ListEditor items={config.options} max={8} placeholder="新增选项" onChange={(options) => set({ options })} /></Field>
      </>;
      break;
    case 'tool':
      body = <>
        <Field label="工具" required>
          <select className="select" value={config.tool_id ?? ''} onChange={(event) => set({ tool_id: event.target.value || null, arguments: {} })}>
            <option value="">请选择</option>
            {resources.tools.filter((item) => item.is_enabled).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </Field>
        {tool?.config.side_effect ? <p className="faint" style={{ color: C.warning }}>该工具会修改外部系统。流程中由编排者显式放置，执行时不再逐次确认。</p> : null}
        {Object.entries(toolParams.properties ?? {}).map(([key, param]) => (
          <Field key={key} label={key} required={toolParams.required?.includes(key)} hint={param.description}>
            <TemplateInput {...io} single value={config.arguments[key] ?? ''} onChange={(text) => set({ arguments: { ...config.arguments, [key]: text } })} />
          </Field>
        ))}
        {!resources.tools.length ? <p className="faint">工具库里还没有工具，管理员可在「集成 → 业务工具」接入 HTTP 接口。</p> : null}
      </>;
      break;
  }

  return (
    <div className="flow-panel">
      <div className="row flow-panel-head">
        <span className="avatar-tile sm" style={{ background: def.color }}><Icon size={14} /></span>
        <input className="input sm grow" style={{ fontWeight: 600 }} aria-label="节点名称" value={spec.title} maxLength={80} onChange={(event) => onChange({ ...spec, title: event.target.value })} />
        <button className="btn ghost sm icon" aria-label="关闭节点配置" onClick={onClose}><X size={14} /></button>
      </div>
      <div className="flow-panel-body">
        <p className="faint" style={{ marginBottom: 12 }}>{def.desc} · 引用名 <span className="mono">{spec.id}</span></p>
        {body}
        {spec.kind !== 'start' ? <>
          <div className="divider" />
          <div className="faint" style={{ marginBottom: 6 }}>输出变量</div>
          <div className="row wrap" style={{ gap: 4 }}>{outputFields(spec, manifest).map(([key, label]) => <Tag key={key} title={`{{${spec.id}.${key}}}`}>{label}</Tag>)}</div>
        </> : null}
      </div>
      {spec.kind !== 'start' ? (
        <div className="row flow-panel-foot">
          <button className="btn sm" onClick={onDuplicate}><Copy size={13} />复制</button>
          <button className="btn sm danger" onClick={onDelete}><Trash2 size={13} />删除节点</button>
        </div>
      ) : null}
    </div>
  );
}

function NodeLibrary({ onAdd, onClose }: { onAdd: (kind: FlowNodeKind) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const items = NODE_DEFS.filter((item) => item.kind !== 'start' && (!query || item.name.includes(query) || item.desc.includes(query)));
  const cats = [...new Set(items.map((item) => item.cat))];
  return (
    <div className="card flow-library">
      <div className="row" style={{ marginBottom: 8 }}><strong className="grow">节点库</strong><button className="btn ghost sm icon" aria-label="收起节点库" onClick={onClose}><X size={14} /></button></div>
      <div className="search-box" style={{ marginBottom: 8 }}><Search size={14} /><input className="input sm" aria-label="搜索节点" placeholder="搜索节点" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      {cats.map((cat) => (
        <div key={cat} style={{ marginBottom: 6 }}>
          <div className="faint" style={{ margin: '6px 4px' }}>{cat}</div>
          {items.filter((item) => item.cat === cat).map((item) => (
            <button key={item.kind} type="button" draggable className="sub-link" style={{ cursor: 'grab', alignItems: 'flex-start' }} aria-label={`添加${item.name}`} title="点击添加，或拖到画布上"
              onDragStart={(event) => { event.dataTransfer.setData('application/x-flow-node', item.kind); event.dataTransfer.effectAllowed = 'move'; }} onClick={() => onAdd(item.kind)}>
              <span className="avatar-tile sm" style={{ background: item.color, width: 22, height: 22 }}><item.icon size={12} /></span>
              <span className="grow"><span style={{ fontSize: 13, display: 'block' }}>{item.name}</span><span className="faint" style={{ fontSize: 11 }}>{item.desc}</span></span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- 编辑器

function Canvas({ app, manifest, patch, resources, beforeSend }: { app: FDEApp; manifest: AppManifest; patch: (value: Partial<AppManifest>) => void; resources: Resources; beforeSend: () => Promise<void> }) {
  const toast = useToast();
  const initial = manifest.graph ?? { nodes: [], edges: [] };
  const [nodes, setNodes] = useState<FlowRFNode[]>(() => initial.nodes.map(toNode));
  const [edges, setEdges] = useState<Edge[]>(() => initial.edges.map(toEdge));
  const [changes, setChanges] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [panel, setPanel] = useState<PanelKey>(null);
  const [library, setLibrary] = useState(true);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [run, setRun] = useState<FlowRun | null>(null);
  const [debugOpened, setDebugOpened] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, setCenter } = useReactFlow();
  const touch = useCallback(() => setChanges((count) => count + 1), []);

  const graph: FlowGraph = useMemo(() => ({
    nodes: nodes.map((node) => ({ ...node.data.spec, position: { x: Math.round(node.position.x), y: Math.round(node.position.y) } })),
    edges: edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, source_handle: edge.sourceHandle ?? null })),
  }), [nodes, edges]);

  // 画布结构变化（增删节点和连线、拖动结束、改配置）时写回草稿，由编辑页统一自动保存
  useEffect(() => { if (changes) patch({ graph }); }, [changes]); // eslint-disable-line react-hooks/exhaustive-deps

  // 每次草稿保存后重新校验，问题节点在画布上标红
  useEffect(() => {
    fdeApi.validate(app.id).then((result) => setIssues(result.issues)).catch(() => undefined);
  }, [app.id, app.updated_at]);

  const savedGraph = app.manifest.graph;
  const issueNodes = useMemo(() => {
    const result = new Set<string>();
    for (const issue of issues) {
      const match = /^graph\.nodes\.(\d+)/.exec(issue.path);
      const id = match ? savedGraph?.nodes[Number(match[1])]?.id : undefined;
      if (id && issue.severity === 'error') result.add(id);
    }
    return result;
  }, [issues, savedGraph]);
  const errors = issues.filter((item) => item.severity === 'error');

  const nameOf = useCallback((list: Array<{ id: string; name?: string; display_name?: string }>, id: string) => {
    const item = list.find((entry) => entry.id === id);
    return item?.display_name ?? item?.name ?? '已删除';
  }, []);
  const describe = useCallback((spec: FlowNodeSpec): string[] => {
    const config = spec.config;
    const model = MODEL_KINDS.includes(spec.kind) ? (config.model_id ? nameOf(resources.models, config.model_id) : '默认模型') : '';
    switch (spec.kind) {
      case 'start': return [['用户问题', ...manifest.input_fields.map((field) => field.label)].join(' · ')];
      case 'llm': return [model, firstLine(config.prompt)];
      case 'kb': return [config.knowledge_base_ids.length ? config.knowledge_base_ids.map((id: string) => nameOf(resources.knowledge, id)).join('、') : '未选择知识库', `${MODES[config.mode as keyof typeof MODES]}检索 · Top ${config.top_k}`];
      case 'classify': return [model];
      case 'extract': return [config.fields.map((item: { label: string }) => item.label).join(' · ') || '未设置字段', model];
      case 'ifelse': return config.conditions.map((item: { left: string; operator: string; right: string }) => `${item.left} ${OPERATORS[item.operator]} ${item.right}`);
      case 'template': case 'answer': return [firstLine(config.template) || '未填写内容'];
      case 'loop': return [`逐项：${config.items || '未指定'}`, `${model} · 并行 ${config.parallel}`];
      case 'form': return [config.fields.map((item: InputField) => item.label).join(' · ') || '未设置字段'];
      case 'choice': return [firstLine(config.prompt)];
      case 'tool': return [config.tool_id ? nameOf(resources.tools, config.tool_id) : '未选择工具'];
      default: return [];
    }
  }, [manifest.input_fields, nameOf, resources]);

  const status = useMemo(() => Object.fromEntries((run?.nodes ?? []).map((item) => [item.id, item.status])), [run]);
  const shownEdges = useMemo(() => edges.map((edge) => {
    const active = run && ['success', 'waiting'].includes(status[edge.source] ?? '') && ['success', 'waiting'].includes(status[edge.target] ?? '');
    return active ? { ...edge, animated: true, style: { stroke: C.primary, strokeWidth: 2 } } : edge;
  }), [edges, run, status]);

  const onNodesChange = useCallback((list: NodeChange<FlowRFNode>[]) => {
    setNodes((current) => applyNodeChanges(list, current));
    if (list.some((item) => item.type === 'remove' || (item.type === 'position' && item.dragging === false))) touch();
    if (list.some((item) => item.type === 'remove' && item.id === selected)) { setSelected(null); setPanel((value) => (value === 'node' ? null : value)); }
  }, [selected, touch]);
  const onEdgesChange = useCallback((list: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(list, current));
    if (list.some((item) => item.type === 'remove')) touch();
  }, [touch]);
  const onConnect = useCallback((connection: Connection) => {
    setEdges((current) => addEdge({ ...connection, id: edgeId(connection.source, connection.sourceHandle, connection.target) }, current));
    touch();
  }, [touch]);
  const isValidConnection = useCallback((connection: Connection | Edge) => {
    const target = nodes.find((node) => node.id === connection.target);
    return connection.source !== connection.target && target?.data.spec.kind !== 'start'
      && !edges.some((edge) => edge.source === connection.source && edge.target === connection.target && (edge.sourceHandle ?? null) === (connection.sourceHandle ?? null));
  }, [edges, nodes]);

  const updateNode = (next: FlowNodeSpec) => {
    const previous = nodes.find((node) => node.id === next.id)?.data.spec;
    setNodes((current) => current.map((node) => (node.id === next.id ? { ...node, data: { spec: next } } : node)));
    // 分支增删后按名称迁移连线：保留仍存在的分支，删掉已移除分支的连线
    if (previous && BRANCH_KINDS.includes(next.kind)) {
      const before = branchLabels(previous);
      const after = branchLabels(next);
      if (before.join('\u0000') !== after.join('\u0000')) {
        setEdges((current) => current.flatMap((edge) => {
          if (edge.source !== next.id) return [edge];
          const moved = after.indexOf(before[Number(String(edge.sourceHandle ?? '').slice(1))]);
          return moved < 0 ? [] : [{ ...edge, sourceHandle: `b${moved}`, id: edgeId(edge.source, `b${moved}`, edge.target) }];
        }));
      }
    }
    touch();
  };

  const addNode = (kind: FlowNodeKind, position?: { x: number; y: number }, base?: FlowNodeSpec) => {
    const rect = wrapper.current?.getBoundingClientRect();
    const at = position ? { ...position } : (base ? { x: base.position.x + 40, y: base.position.y + 60 } : screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 800) / 2 - 120, y: (rect?.top ?? 0) + (rect?.height ?? 600) / 2 - 40 }));
    while (!position && graph.nodes.some((node) => Math.abs(node.position.x - at.x) < 200 && Math.abs(node.position.y - at.y) < 90)) at.y += 110;
    const spec: FlowNodeSpec = { id: nextNodeId(graph, kind), kind, title: base ? `${base.title}（副本）` : DEF[kind].name, position: at, config: base ? structuredClone(base.config) : defaultConfig(kind) };
    setNodes((current) => [...current.map((node) => ({ ...node, selected: false })), { ...toNode(spec), selected: true }]);
    setSelected(spec.id);
    setPanel('node');
    touch();
  };

  const removeNode = (id: string) => {
    setNodes((current) => current.filter((node) => node.id !== id));
    setEdges((current) => current.filter((edge) => edge.source !== id && edge.target !== id));
    setSelected(null);
    setPanel(null);
    touch();
    toast('节点已删除');
  };

  const focusNode = (id: string) => {
    const node = nodes.find((item) => item.id === id);
    if (!node) return;
    setNodes((current) => current.map((item) => ({ ...item, selected: item.id === id })));
    setSelected(id);
    setPanel('node');
    setCenter(node.position.x + 130, node.position.y + 60, { zoom: 1, duration: 300 });
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const kind = event.dataTransfer.getData('application/x-flow-node') as FlowNodeKind;
    if (kind) addNode(kind, screenToFlowPosition({ x: event.clientX - 120, y: event.clientY - 20 }));
  };

  const selectedSpec = nodes.find((node) => node.id === selected)?.data.spec;
  const view = useMemo(() => ({ status, issueNodes, describe }), [status, issueNodes, describe]);
  const openDebug = () => { setPanel('debug'); setDebugOpened(true); };

  return (
    <ViewContext.Provider value={view}>
      <div className="flow-editor">
        <div ref={wrapper} className="flow-canvas" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; }} onDrop={onDrop}>
          <ReactFlow nodes={nodes} edges={shownEdges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} isValidConnection={isValidConnection}
            onNodeClick={(_, node) => { setSelected(node.id); setPanel('node'); }} onPaneClick={() => { setSelected(null); setPanel((value) => (value === 'node' ? null : value)); }}
            fitView fitViewOptions={{ padding: { left: '290px', top: '70px', right: '40px', bottom: '60px' }, maxZoom: 1 }} minZoom={0.2} maxZoom={1.6} deleteKeyCode={['Backspace', 'Delete']}
            defaultEdgeOptions={{ style: { strokeWidth: 1.6, stroke: '#9fb3b0' } }} proOptions={{ hideAttribution: true }}>
            <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} color="#cfd9d7" />
            <MiniMap pannable zoomable style={{ width: 150, height: 96 }} nodeColor={(node) => DEF[(node as FlowRFNode).data.spec.kind].color} />
            <Controls showInteractive={false} position="bottom-center" orientation="horizontal" />
            <Panel position="top-left">
              {library ? <NodeLibrary onAdd={(kind) => addNode(kind)} onClose={() => setLibrary(false)} /> : <button className="btn" style={{ boxShadow: 'var(--shadow-sm)' }} onClick={() => setLibrary(true)}><Plus size={15} />添加节点</button>}
            </Panel>
            <Panel position="top-right">
              <div className="row wrap flow-toolbar">
                <span className="faint flow-count">{nodes.length} 个节点 · {edges.length} 条连线</span>
                <button className={`btn ${panel === 'settings' ? 'active' : ''}`} onClick={() => setPanel(panel === 'settings' ? null : 'settings')}><Settings2 size={14} />全局设置</button>
                <button className="btn" onClick={() => setPanel(panel === 'issues' ? null : 'issues')}>{errors.length ? <AlertTriangle size={14} color={C.danger} /> : <CheckCircle2 size={14} color={C.success} />}{errors.length ? `${errors.length} 个问题` : '检查通过'}</button>
                <button className="btn primary" onClick={openDebug}><Bug size={14} />调试</button>
              </div>
            </Panel>
          </ReactFlow>
        </div>
        {panel || debugOpened ? (
          <aside className="flow-aside" style={{ display: panel ? undefined : 'none' }}>
            {panel === 'node' && selectedSpec ? (
              <NodeConfig key={selectedSpec.id} spec={selectedSpec} graph={graph} manifest={manifest} resources={resources} onChange={updateNode}
                onDelete={() => removeNode(selectedSpec.id)} onDuplicate={() => addNode(selectedSpec.kind, undefined, selectedSpec)} onSettings={() => setPanel('settings')} onClose={() => setPanel(null)} />
            ) : null}
            {panel === 'settings' ? (
              <div className="flow-panel">
                <div className="row flow-panel-head"><Settings2 size={16} color={C.primary} /><strong className="grow">全局设置</strong><button className="btn ghost sm icon" aria-label="关闭" onClick={() => setPanel(null)}><X size={14} /></button></div>
                <div className="flow-panel-body" style={{ paddingTop: 0 }}><AppConfigForm manifest={manifest} patch={patch} {...resources} /></div>
              </div>
            ) : null}
            {panel === 'issues' ? (
              <div className="flow-panel">
                <div className="row flow-panel-head"><strong className="grow">配置检查</strong><button className="btn ghost sm icon" aria-label="关闭" onClick={() => setPanel(null)}><X size={14} /></button></div>
                <div className="flow-panel-body">
                  {!issues.length ? <p className="faint">没有发现问题，可以调试和发布。</p> : null}
                  {issues.map((issue, index) => {
                    const match = /^graph\.nodes\.(\d+)/.exec(issue.path);
                    const id = match ? savedGraph?.nodes[Number(match[1])]?.id : undefined;
                    return (
                      <button key={`${issue.path}-${index}`} type="button" className="sub-link" style={{ alignItems: 'flex-start' }} disabled={!id} onClick={() => id && focusNode(id)}>
                        {issue.severity === 'error' ? <CircleAlert size={15} color={C.danger} style={{ flex: 'none', marginTop: 2 }} /> : <AlertTriangle size={15} color={C.warning} style={{ flex: 'none', marginTop: 2 }} />}
                        <span className="grow" style={{ fontSize: 13 }}>{issue.message}</span>
                      </button>
                    );
                  })}
                  <p className="faint" style={{ marginTop: 12 }}>保存草稿后自动重新检查。存在红色问题时不能调试运行和发布。</p>
                </div>
              </div>
            ) : null}
            {/* 调试对话常驻挂载：切到节点配置再回来，会话与暂停的步骤都还在 */}
            {debugOpened ? (
              <div className="flow-panel" style={{ display: panel === 'debug' ? 'flex' : 'none' }}>
                <ChatPanel appId={app.id} manifest={manifest} mode="debug" beforeSend={beforeSend} onFlow={setRun}
                  title={<><Bug size={15} color={C.primary} /><strong>调试运行</strong><Tag tone="orange">草稿</Tag><button className="btn ghost sm icon" aria-label="关闭调试" onClick={() => setPanel(null)}><X size={14} /></button></>} />
              </div>
            ) : null}
          </aside>
        ) : null}
      </div>
    </ViewContext.Provider>
  );
}

export function FlowEditor(props: { app: FDEApp; manifest: AppManifest; patch: (value: Partial<AppManifest>) => void; resources: Resources; beforeSend: () => Promise<void> }) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}

