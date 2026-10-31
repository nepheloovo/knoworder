import { ArrowLeft, Blocks, Check, CheckCircle2, ChevronDown, ChevronRight, FileSpreadsheet, FileText, Globe, Plug, Type, UploadCloud, X, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  API_BASE_URL, apiFetch, errorMessage, type ApiChunkConfig, type ApiChunkPreview, type ApiImportJob, type ApiKnowledgeBase, type ApiKnowledgeFile,
} from '../api/client';
import { ChunkConfigFields } from '../components/ChunkConfigFields';
import { Field, Loading, Notice, Spinner, Tag, formatBytes, useToast } from '../components/ui';
import { ACTIVE_STATUSES, CHUNK_METHODS, configProblem, defaultChunkConfig, detectRecommendation, METHOD_LABEL, STAGE_LABEL, type ChunkMethod } from '../lib/knowledge';
import { C } from '../theme';

type Source = 'file' | 'web' | 'text' | 'feishu' | 'api';

interface Pending {
  id: string;
  file: File;
  config: ApiChunkConfig;
  recommended: ChunkMethod;
  reason: string;
  preview?: ApiChunkPreview;
  previewError?: string;
}

interface Upload { id: string; name: string; job?: ApiImportJob; fileStatus?: string; error?: string }

const SOURCES: Array<{ key: Source; name: string; icon: typeof UploadCloud; soon?: boolean }> = [
  { key: 'file', name: '本地文件', icon: UploadCloud },
  { key: 'web', name: '网页链接', icon: Globe },
  { key: 'text', name: '自定义文本', icon: Type },
  { key: 'feishu', name: '飞书文档', icon: Blocks, soon: true },
  { key: 'api', name: 'API 推送', icon: Plug },
];

const ACCEPT = '.pdf,.docx,.md,.markdown,.png,.jpg,.jpeg,.webp,.xlsx,.xlsm,.csv';

export function ImportWizardPage() {
  const { kbId = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [kb, setKb] = useState<ApiKnowledgeBase | null>(null);
  const [step, setStep] = useState(1);
  // 看板「补充知识」带着未解决的问题过来：直接进入自定义文本，问题作标题，只需补答案
  const [searchParams] = useSearchParams();
  const gapQuestion = searchParams.get('question')?.trim() ?? '';
  const [source, setSource] = useState<Source>(gapQuestion ? 'text' : 'file');
  const [items, setItems] = useState<Pending[]>([]);
  const [activeId, setActiveId] = useState('');
  const [text, setText] = useState(gapQuestion ? { title: gapQuestion.slice(0, 80), content: `问：${gapQuestion}\n\n答：` } : { title: '', content: '' });
  const [web, setWeb] = useState({ url: '', title: '', method: 'heading' as ChunkMethod });
  const [previewing, setPreviewing] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [paramsOpen, setParamsOpen] = useState(false);

  useEffect(() => {
    apiFetch<ApiKnowledgeBase>(`/knowledge-bases/${kbId}`).then(setKb).catch((caught) => toast(errorMessage(caught), 'error'));
  }, [kbId, toast]);

  const active = items.find((item) => item.id === activeId) ?? items[0];

  // 按文件类型（表格还会读表头判断是否为问答对）自动匹配切块方式，进入下一步后可逐个调整
  const addFiles = async (files: File[]) => {
    if (!kb || !files.length) return;
    const fresh = files.filter((file) => !items.some((item) => item.file.name === file.name && item.file.size === file.size));
    if (fresh.length < files.length) toast(`已跳过 ${files.length - fresh.length} 个重复文件`);
    if (!fresh.length) return;
    const added = await Promise.all(fresh.map(async (file) => {
      const rec = await detectRecommendation(file);
      return { id: crypto.randomUUID(), file, config: defaultChunkConfig(kb, rec.method), recommended: rec.method, reason: rec.reason };
    }));
    setItems((current) => [...current, ...added]);
    setActiveId((current) => current || added[0].id);
  };

  const patch = (patchValue: Partial<ApiChunkConfig>) => {
    if (!active) return;
    setItems((current) => current.map((item) => (item.id === active.id ? { ...item, config: { ...item.config, ...patchValue }, previewError: undefined } : item)));
  };

  const preview = useCallback(async (item: Pending) => {
    if (!kb || configProblem(item.config, kb)) return;
    setPreviewing(true);
    try {
      const form = new FormData();
      form.append('upload', item.file);
      form.append('config', JSON.stringify(item.config));
      const result = await apiFetch<ApiChunkPreview>(`/knowledge-bases/${kbId}/chunk-preview`, { method: 'POST', body: form });
      setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, preview: result, previewError: undefined } : entry)));
    } catch (caught) {
      setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, preview: undefined, previewError: errorMessage(caught) } : entry)));
    } finally {
      setPreviewing(false);
    }
  }, [kb, kbId]);

  // 非 LLM 切块方式：参数变化后自动刷新真实预览（防抖）
  const configKey = active ? `${active.id}:${JSON.stringify(active.config)}` : '';
  const lastKey = useRef('');
  useEffect(() => {
    if (step !== 2 || !active || active.config.method === 'semantic' || configKey === lastKey.current) return undefined;
    const timer = window.setTimeout(() => { lastKey.current = configKey; void preview(active); }, 500);
    return () => window.clearTimeout(timer);
  }, [step, configKey, active, preview]);

  const pollUploads = useCallback(async (current: Upload[]) => {
    const files = await apiFetch<ApiKnowledgeFile[]>(`/knowledge-bases/${kbId}/files`);
    const jobs = await apiFetch<ApiImportJob[]>(`/knowledge-bases/${kbId}/import-jobs`);
    return current.map((upload) => {
      if (upload.error || !upload.job) return upload;
      const job = jobs.find((item) => item.id === upload.job?.id) ?? upload.job;
      return { ...upload, job, fileStatus: files.find((file) => file.id === job.file_id)?.status };
    });
  }, [kbId]);

  const running = uploads.some((upload) => upload.job && ACTIVE_STATUSES.has(upload.job.status));
  useEffect(() => {
    if (!running) return undefined;
    const timer = window.setInterval(() => { void pollUploads(uploads).then(setUploads).catch(() => undefined); }, 2000);
    return () => window.clearInterval(timer);
  }, [running, uploads, pollUploads]);

  const startImport = async () => {
    if (!kb) return;
    setImporting(true);
    setStep(4);
    const results: Upload[] = [];
    if (source === 'web') {
      try {
        const response = await apiFetch<{ file: ApiKnowledgeFile; job: ApiImportJob }>(`/knowledge-bases/${kbId}/web-import`, { method: 'POST', body: JSON.stringify({ url: web.url.trim(), title: web.title.trim() || null, chunk_config: defaultChunkConfig(kb, web.method) }) });
        results.push({ id: response.file.id, name: response.file.filename, job: response.job, fileStatus: response.file.status });
      } catch (caught) {
        results.push({ id: 'web', name: web.url, error: errorMessage(caught) });
      }
    } else {
      for (const item of items) {
        try {
          const form = new FormData();
          form.append('upload', item.file);
          form.append('config', JSON.stringify(item.config));
          const response = await apiFetch<{ file: ApiKnowledgeFile; job: ApiImportJob }>(`/knowledge-bases/${kbId}/files`, { method: 'POST', body: form });
          results.push({ id: item.id, name: item.file.name, job: response.job, fileStatus: response.file.status });
        } catch (caught) {
          results.push({ id: item.id, name: item.file.name, error: errorMessage(caught) });
        }
        setUploads([...results]);
      }
    }
    setUploads(results);
    setImporting(false);
  };

  if (!kb) return <Loading />;

  const canNext = source === 'web' ? /^https?:\/\//.test(web.url.trim()) : items.length > 0;
  const allProblems = items.map((item) => configProblem(item.config, kb)).filter(Boolean);
  const done = step === 4 && !importing && !running;
  const failed = uploads.filter((upload) => upload.error || upload.job?.status === 'failed').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="topbar">
        <button className="btn ghost sm" onClick={() => navigate(`/knowledge/${kbId}`)}><ArrowLeft size={15} />{kb.name}</button>
        <span className="title">导入数据</span>
        <span className="grow" />
        <div className="steps">
          {['选择数据源', '切块与预览', '确认导入'].map((label, index) => (
            <div key={label} className="row" style={{ gap: 8 }}>
              {index ? <span className="step-line" /> : null}
              <div className={`step ${step === index + 1 ? 'active' : step > index + 1 ? 'done' : ''}`}><span className="n">{step > index + 1 ? <Check size={13} /> : index + 1}</span>{label}</div>
            </div>
          ))}
        </div>
        <span className="grow" />
        {step > 1 && step < 4 ? <button className="btn" onClick={() => setStep(source === 'web' && step === 3 ? 1 : step - 1)}>上一步</button> : null}
        {step === 1 ? <button className="btn primary" disabled={!canNext || source === 'feishu' || source === 'api'} onClick={() => setStep(source === 'web' ? 3 : 2)}>下一步</button> : null}
        {step === 2 ? <button className="btn primary" disabled={!!allProblems.length} onClick={() => setStep(3)}>下一步</button> : null}
        {step === 3 ? <button className="btn primary" onClick={() => void startImport()}><UploadCloud size={15} />开始导入</button> : null}
        {done ? <>
          <button className="btn" onClick={() => { setItems([]); setUploads([]); setActiveId(''); setWeb({ url: '', title: '', method: 'heading' }); setStep(1); }}>继续导入</button>
          {uploads.length > failed ? <button className="btn" onClick={() => navigate(`/knowledge/${kbId}/search`)}>去检索测试</button> : null}
          <button className="btn primary" onClick={() => navigate(`/knowledge/${kbId}`)}>返回数据集</button>
        </> : null}
      </div>

      {step === 1 ? (
        <div className="page" style={{ maxWidth: 980, margin: '0 auto', width: '100%' }}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
            {SOURCES.map(({ key, name, icon: Icon, soon }) => (
              <button key={key} className={`method-card ${source === key ? 'active' : ''} ${soon ? 'coming-soon' : ''}`} disabled={soon} style={{ flexDirection: 'column', alignItems: 'center', padding: 14 }} onClick={() => setSource(key)}>
                <Icon size={22} color="var(--primary)" /><h4>{name}</h4>{soon ? <Tag>即将上线</Tag> : null}
              </button>
            ))}
          </div>
          <div style={{ marginTop: 20 }}>
            {source === 'file' ? <>
              <label className="upload-zone" style={dragging ? { borderColor: 'var(--primary)', background: 'var(--primary-50)' } : undefined}
                onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
                onDrop={(event) => { event.preventDefault(); setDragging(false); void addFiles(Array.from(event.dataTransfer.files)); }}>
                <UploadCloud size={30} color="var(--primary)" />
                <strong style={{ color: 'var(--text-1)' }}>{dragging ? '松开以添加文件' : '点击或拖拽文件到此处'}</strong>
                <span>支持 PDF、DOCX、Markdown、图片、XLSX、CSV。下一步会按文件自动匹配切块方式，问答对表格（表头含「问题 / 答案」）也会自动识别</span>
                <input type="file" multiple hidden accept={ACCEPT} onChange={(event) => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
              </label>
            </> : null}
            {source === 'text' ? (
              <div className="card pad">
                <Field label="标题" required><input className="input" value={text.title} onChange={(event) => setText({ ...text, title: event.target.value })} placeholder="例如：新品上市统一口径" /></Field>
                <Field label="内容" required hint="支持 Markdown"><textarea className="textarea" style={{ minHeight: 220 }} value={text.content} onChange={(event) => setText({ ...text, content: event.target.value })} /></Field>
                <button className="btn" disabled={!text.title.trim() || !text.content.trim()} onClick={() => { void addFiles([new File([`# ${text.title.trim()}\n\n${text.content.trim()}\n`], `${text.title.trim().replace(/[\\/:*?"<>|]+/g, '_')}.md`, { type: 'text/markdown' })]); setText({ title: '', content: '' }); }}><FileText size={15} />加入待导入列表</button>
              </div>
            ) : null}
            {source === 'web' ? (
              <div className="card pad">
                <Notice tone="info" title="安全抓取">只允许公网 HTTP/HTTPS 地址，拒绝内网、环回和保留地址。</Notice>
                <div style={{ height: 12 }} />
                <Field label="网页地址" required><input className="input" value={web.url} onChange={(event) => setWeb({ ...web, url: event.target.value })} placeholder="https://help.example.com/docs/article" /></Field>
                <Field label="文档标题" hint="可选，默认读取网页标题"><input className="input" value={web.title} onChange={(event) => setWeb({ ...web, title: event.target.value })} /></Field>
                <Field label="切块方式" hint="网页正文会转为 Markdown">
                  <select className="select" value={web.method} onChange={(event) => setWeb({ ...web, method: event.target.value as ChunkMethod })}>
                    {(['heading', 'recursive', 'fixed', 'parent_child'] as const).map((method) => <option key={method} value={method}>{METHOD_LABEL[method]}</option>)}
                  </select>
                </Field>
                {items.length ? <Notice tone="warn">已添加的 {items.length} 个文件不会随网页一起导入；切回「本地文件」可继续导入它们。</Notice> : null}
              </div>
            ) : null}
            {source === 'api' ? (
              <div className="card pad">
                <p className="muted" style={{ marginBottom: 12 }}>业务系统可用具备 <code>knowledge:write</code> 权限的 Token 推送文件，切块参数与界面一致。</p>
                <div className="code-block">{`curl -X POST "${window.location.origin}${API_BASE_URL}/knowledge-bases/${kbId}/files" \\
  -H "Authorization: Bearer $TOKEN" \\
  -F "upload=@document.pdf" \\
  -F 'config={"method":"heading","heading_level":2,"chunk_size":800,"chunk_overlap":80}'`}</div>
              </div>
            ) : null}
            {items.length && source !== 'web' && source !== 'api' ? (
              <div className="col" style={{ marginTop: 16, gap: 8 }}>
                {items.map((item) => (
                  <div key={item.id} className="card row" style={{ padding: '10px 14px' }}>
                    {/\.(csv|xlsx|xlsm)$/i.test(item.file.name) ? <FileSpreadsheet size={18} color={C.success} /> : <FileText size={18} color={C.primary} />}
                    <div className="grow"><div style={{ fontWeight: 500 }}>{item.file.name}</div><div className="faint">{formatBytes(item.file.size)} · 将按「{METHOD_LABEL[item.recommended]}」切块（{item.reason}）</div></div>
                    <button className="btn ghost sm icon" aria-label={`移除 ${item.file.name}`} onClick={() => setItems((current) => current.filter((entry) => entry.id !== item.id))}><X size={14} /></button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {step === 2 && active ? (
        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* 左：文件列表，每个文件带自动匹配的切块方式 */}
          <aside style={{ width: 280, flex: 'none', borderRight: '1px solid var(--border)', overflow: 'auto', padding: 16, background: 'var(--surface)' }}>
            <div className="field-label">文件 {items.length}<span className="hint">已按格式自动匹配</span></div>
            <div className="col" style={{ gap: 4 }}>
              {items.map((item) => {
                const problem = configProblem(item.config, kb);
                const table = /\.(csv|xlsx|xlsm)$/i.test(item.file.name);
                return (
                  <button key={item.id} className={`sub-link ${item.id === active.id ? 'active' : ''}`} style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2, padding: '8px 10px' }} onClick={() => setActiveId(item.id)}>
                    <span className="row" style={{ gap: 6 }}>{table ? <FileSpreadsheet size={15} color={C.success} /> : <FileText size={15} />}<span className="grow ellipsis">{item.file.name}</span></span>
                    <span className="row" style={{ gap: 4, paddingLeft: 21 }}>
                      {problem ? <Tag tone="red">需调整</Tag> : <span className="faint" style={{ fontSize: 12 }}>{METHOD_LABEL[item.config.method]}{item.config.method === item.recommended ? ' · 自动' : ' · 已调整'}</span>}
                      {item.preview ? <span className="faint" style={{ fontSize: 12 }}>· {item.preview.total_chunks} 块</span> : null}
                      {item.previewError ? <Tag tone="red">预览失败</Tag> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          {/* 右：当前文件的切块方式、参数与预览 */}
          <section style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: 'var(--bg-soft)' }}>
            <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
              <div className="row" style={{ gap: 10 }}>
                <strong className="ellipsis" style={{ maxWidth: 320 }}>{active.file.name}</strong>
                <span className="faint">切块方式</span>
                <select className="select sm" style={{ width: 200 }} aria-label="切块方式" value={active.config.method} onChange={(event) => patch({ method: event.target.value as ChunkMethod })}>
                  {CHUNK_METHODS.map((method) => {
                    const blocked = (['table_row', 'qa'].includes(method.value) && !/\.(csv|xlsx|xlsm)$/i.test(active.file.name)) || (method.needsLlm && !kb.semantic_llm_model_id);
                    return <option key={method.value} value={method.value} disabled={blocked}>{method.label}{method.value === active.recommended ? '（推荐）' : ''}</option>;
                  })}
                </select>
                <button className="btn sm ghost" aria-expanded={paramsOpen} onClick={() => setParamsOpen(!paramsOpen)}>{paramsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}调整参数</button>
                <span className="grow" />
                {active.preview ? <span className="faint">共 <strong style={{ color: 'var(--text-1)' }}>{active.preview.total_chunks}</strong> 块 · 平均 {Math.round(active.preview.chunks.reduce((sum, chunk) => sum + chunk.char_count, 0) / Math.max(1, active.preview.chunks.length))} 字</span> : null}
                {previewing ? <Spinner /> : null}
                {active.config.method === 'semantic' ? <button className="btn sm primary" disabled={previewing} onClick={() => void preview(active)}>调用模型预览</button> : null}
              </div>
              <div className="faint" style={{ marginTop: 4 }}>{CHUNK_METHODS.find((item) => item.value === active.config.method)?.description}{active.config.method === active.recommended ? `。按「${active.reason}」自动匹配` : ''}</div>
              {paramsOpen ? (
                <div style={{ marginTop: 12, maxWidth: 560 }}>
                  <ChunkConfigFields config={active.config} patch={patch} kb={kb} />
                  {items.length > 1 ? <button className="btn sm ghost" style={{ color: 'var(--primary)', marginTop: 4 }} onClick={() => { setItems((current) => current.map((item) => ({ ...item, config: { ...active.config } }))); toast('已应用到全部文件'); }}>把当前设置应用到全部文件</button> : null}
                </div>
              ) : null}
            </div>
            <div style={{ flex: 1, overflow: 'auto', padding: 20, opacity: previewing ? 0.55 : 1, transition: 'opacity .2s' }}>
              {configProblem(active.config, kb) ? <Notice tone="error">{configProblem(active.config, kb)}</Notice> : null}
              {active.previewError ? <Notice tone="error" title="预览失败" action={active.previewError.includes('OCR') ? <button className="btn sm" onClick={() => navigate(`/knowledge/${kbId}/settings`)}>去配置 OCR 模型</button> : undefined}>{active.previewError}</Notice> : null}
              {active.config.enhance_keywords || active.config.enhance_qa ? <div style={{ marginBottom: 8 }}><Notice tone="info">{[active.config.enhance_keywords ? '关键词' : '', active.config.enhance_qa ? '问答对' : ''].filter(Boolean).join('和')}会在导入时生成，预览只展示切块结果。</Notice></div> : null}
              {active.preview?.warnings.map((warning) => <div key={warning} style={{ marginBottom: 8 }}><Notice tone="warn">{warning}</Notice></div>)}
              {!active.preview && !active.previewError && !previewing ? <p className="faint">{active.config.method === 'semantic' ? '语义分块会调用模型，点击右上角按钮生成预览。' : '正在生成预览…'}</p> : null}
              <div className="col" style={{ gap: 10 }}>
                {active.preview?.chunks.map((chunk) => (
                  <div key={chunk.ordinal} className="chunk-card">
                    <header><span className="idx">#{chunk.ordinal}</span><span className="ellipsis grow">{chunk.title}</span>{chunk.metadata.page_number ? <span>第 {String(chunk.metadata.page_number)} 页</span> : null}<span>{chunk.char_count} 字</span></header>
                    <div className="body">{chunk.content}</div>
                    {chunk.metadata.parent_content ? <div className="child body" style={{ fontSize: 12 }}>父块：{String(chunk.metadata.parent_content).slice(0, 160)}{String(chunk.metadata.parent_content).length > 160 ? '…' : ''}</div> : null}
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      ) : null}

      {step >= 3 ? (
        <div className="page" style={{ maxWidth: 980, margin: '0 auto', width: '100%' }}>
          {step === 3 ? <p className="muted" style={{ marginBottom: 12 }}>开始后会写入对象存储，执行解析、元数据抽取、切块和向量化。新分块完成后即可被引用本库的应用检索，无需重新发布应用。</p> : null}
          <div className="card">
            <table className="table">
              <thead><tr><th>数据源</th><th>切块方式</th><th>预览分块</th><th style={{ width: 240 }}>{step === 4 ? '进度' : '状态'}</th></tr></thead>
              <tbody>
                {source === 'web' ? (
                  <tr><td><div className="row"><Globe size={16} color={C.success} />{web.title || web.url}</div></td><td><Tag tone="blue">{METHOD_LABEL[web.method]}</Tag></td><td>—</td><td><UploadState upload={uploads[0]} pending={step === 3} /></td></tr>
                ) : items.map((item, index) => (
                  <tr key={item.id}>
                    <td><div className="row"><FileText size={16} color={C.primary} />{item.file.name}</div></td>
                    <td><Tag tone="blue">{METHOD_LABEL[item.config.method]}</Tag></td>
                    <td>{item.preview ? item.preview.total_chunks : <span className="faint">未预览</span>}</td>
                    <td><UploadState upload={uploads.find((upload) => upload.id === item.id) ?? (step === 4 && importing && index >= uploads.length ? { id: item.id, name: item.file.name } : undefined)} pending={step === 3} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {done ? <div style={{ marginTop: 16 }}><Notice tone={failed ? 'warn' : 'success'} title={failed ? `${uploads.length - failed} 个成功，${failed} 个失败` : '导入完成'}>{failed ? '失败的文件可在数据集中查看原因并重试。' : '新分块已可被检索，可以去「检索测试」验证效果。'}</Notice></div> : null}
        </div>
      ) : null}
    </div>
  );
}

function UploadState({ upload, pending }: { upload?: Upload; pending: boolean }) {
  if (pending) return <span className="faint">待导入</span>;
  if (!upload) return <span className="faint">排队中</span>;
  if (upload.error) return <div><Tag tone="red"><XCircle size={12} />上传失败</Tag><div className="faint">{upload.error}</div></div>;
  const job = upload.job;
  if (!job) return <span className="row faint"><Spinner size={12} />上传中</span>;
  if (job.status === 'completed') return <Tag tone="green"><CheckCircle2 size={12} />完成</Tag>;
  if (job.status === 'failed') return <div><Tag tone="red"><XCircle size={12} />失败</Tag><div className="faint">{job.error_message}</div></div>;
  return <div><div className="row faint" style={{ marginBottom: 4 }}><Spinner size={12} />{STAGE_LABEL[job.current_stage] ?? job.current_stage} · {job.progress}%</div><div className="progress"><i style={{ width: `${job.progress}%` }} /></div></div>;
}
