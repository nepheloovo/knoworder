import { AlertCircle, ArrowLeft, ChevronRight, FileSpreadsheet, FileText, FlaskConical, Globe, RefreshCw, Search, Settings2, Tags, Trash2, Upload } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import {
  apiFetch, errorMessage, type ApiChunk, type ApiChunkConfig, type ApiImportJob, type ApiKnowledgeBase, type ApiKnowledgeFile,
  type ApiModelOption, type ApiRetrievalResponse,
} from '../api/client';
import { fdeApi, type FDEApp } from '../api/fde';
import { ChunkConfigFields, MethodPicker } from '../components/ChunkConfigFields';
import {
  ConfirmModal, Drawer, Empty, Field, Loading, Modal, Notice, Slider, Spinner, Tag, formatBytes, formatTime, useToast,
} from '../components/ui';
import { withRetrievalConfig } from '../lib/apps';
import { ACTIVE_STATUSES, configProblem, defaultChunkConfig, FILE_STATUS, METHOD_LABEL, modelsOf, recommendedMethod, STAGE_LABEL } from '../lib/knowledge';
import { C } from '../theme';

function FileIcon({ file }: { file: Pick<ApiKnowledgeFile, 'extension' | 'filename'> }) {
  if (['csv', 'xlsx', 'xlsm'].includes(file.extension)) return <FileSpreadsheet size={17} color={C.success} />;
  if (file.filename.startsWith('http')) return <Globe size={17} color={C.success} />;
  return <FileText size={17} color={C.primary} />;
}

export function KnowledgeDetailPage() {
  const { kbId = '' } = useParams();
  const [kb, setKb] = useState<ApiKnowledgeBase | null>(null);
  const [apps, setApps] = useState<FDEApp[]>([]);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      setKb(await apiFetch<ApiKnowledgeBase>(`/knowledge-bases/${kbId}`));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, [kbId]);

  useEffect(() => { void reload(); fdeApi.list().then(setApps).catch(() => undefined); }, [reload]);

  if (error) return <div className="page"><Notice tone="error" title="无法加载知识库">{error}</Notice></div>;
  if (!kb) return <Loading />;
  const base = `/knowledge/${kb.id}`;
  const usedBy = apps.filter((app) => app.manifest.knowledge_base_ids.includes(kb.id));
  return (
    <div className="sub-layout">
      <aside className="sub-side">
        <Link className="back" to="/knowledge"><ArrowLeft size={14} />全部知识库</Link>
        <div style={{ padding: '0 6px 14px' }}><strong style={{ display: 'block' }}>{kb.name}</strong><span className="faint">{kb.file_count} 个文件 · {kb.chunk_count.toLocaleString()} 个分块</span></div>
        <NavLink end to={base} className={({ isActive }) => `sub-link ${isActive ? 'active' : ''}`}><FileText size={16} />数据集</NavLink>
        <NavLink to={`${base}/search`} className={({ isActive }) => `sub-link ${isActive ? 'active' : ''}`}><FlaskConical size={16} />检索测试</NavLink>
        <NavLink to={`${base}/settings`} className={({ isActive }) => `sub-link ${isActive ? 'active' : ''}`}><Settings2 size={16} />配置</NavLink>
        <div className="divider" />
        <div className="faint" style={{ padding: '0 6px 6px' }}>引用本库的应用</div>
        {usedBy.length ? usedBy.map((app) => <Link key={app.id} to={`/apps/${app.id}`} className="sub-link" style={{ fontSize: 13 }}>{app.name}</Link>) : <span className="faint" style={{ padding: '0 6px' }}>暂无</span>}
      </aside>
      <section className="sub-main">
        <Routes>
          <Route index element={<FilesView kb={kb} onChanged={reload} />} />
          <Route path="files/:fileId" element={<ChunksView kb={kb} />} />
          <Route path="search" element={<SearchView kb={kb} usedBy={usedBy} />} />
          <Route path="settings" element={<SettingsView kb={kb} onSaved={setKb} usedBy={usedBy} />} />
        </Routes>
      </section>
    </div>
  );
}

/* ------------------------------ 数据集 ------------------------------ */

function FilesView({ kb, onChanged }: { kb: ApiKnowledgeBase; onChanged: () => void }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [files, setFiles] = useState<ApiKnowledgeFile[] | null>(null);
  const [jobs, setJobs] = useState<ApiImportJob[]>([]);
  const [filter, setFilter] = useState<'all' | 'ready' | 'active' | 'failed'>('all');
  const [q, setQ] = useState('');
  const [rechunk, setRechunk] = useState<{ file: ApiKnowledgeFile; config: ApiChunkConfig; discardEdits?: boolean } | null>(null);
  const [removing, setRemoving] = useState<ApiKnowledgeFile | null>(null);
  const [meta, setMeta] = useState<ApiKnowledgeFile | null>(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const [loadedFiles, loadedJobs] = await Promise.all([
      apiFetch<ApiKnowledgeFile[]>(`/knowledge-bases/${kb.id}/files`),
      apiFetch<ApiImportJob[]>(`/knowledge-bases/${kb.id}/import-jobs`),
    ]);
    setFiles(loadedFiles);
    setJobs(loadedJobs);
    return loadedFiles;
  }, [kb.id]);

  useEffect(() => { void load().catch((caught) => toast(errorMessage(caught), 'error')); }, [load, toast]);

  const latestJob = useMemo(() => {
    const map: Record<string, ApiImportJob> = {};
    for (const job of jobs) if (!map[job.file_id] || job.created_at > map[job.file_id].created_at) map[job.file_id] = job;
    return map;
  }, [jobs]);
  // 重试后到 worker 接手前文件仍是旧状态，所以同时看最新任务的状态
  const isActive = (file: ApiKnowledgeFile) => ACTIVE_STATUSES.has(file.status) || ACTIVE_STATUSES.has(latestJob[file.id]?.status ?? '');
  const activeCount = files?.filter(isActive).length ?? 0;
  useEffect(() => {
    if (!activeCount) return undefined;
    const timer = window.setInterval(() => {
      void load().then((latest) => { if (!latest.some((file) => ACTIVE_STATUSES.has(file.status))) onChanged(); });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [activeCount, load, onChanged]);

  const rows = (files ?? []).filter((file) => {
    if (q && !file.filename.includes(q)) return false;
    if (filter === 'ready') return file.status === 'completed';
    if (filter === 'active') return isActive(file);
    if (filter === 'failed') return file.status === 'failed';
    return true;
  });

  const retry = async (file: ApiKnowledgeFile, config?: ApiChunkConfig, discardEdits = false): Promise<boolean> => {
    setBusy(file.id);
    try {
      await apiFetch(`/knowledge-bases/${kb.id}/files/${file.id}/retry`, { method: 'POST', body: JSON.stringify(config ? { chunk_config: config, discard_manual_edits: discardEdits } : {}) });
      toast(config ? `已按「${METHOD_LABEL[config.method]}」重新切块` : '已重新处理');
      await load();
      onChanged();
      return true;
    } catch (caught) {
      toast(errorMessage(caught), 'error');
      return false;
    } finally {
      setBusy('');
    }
  };

  const failedCount = files?.filter((file) => file.status === 'failed').length ?? 0;
  const rechunkProblem = rechunk ? configProblem(rechunk.config, kb) : null;

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow"><h1>数据集</h1><p>每个文件独立设置切块方式，可随时重新切块，不影响其他文件。</p></div>
        <button className="btn" onClick={() => void load()}><RefreshCw size={15} />刷新</button>
        <button className="btn primary" onClick={() => navigate(`/knowledge/${kb.id}/import`)}><Upload size={15} />导入数据</button>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="seg">
          {([['all', '全部'], ['ready', '已就绪'], ['active', '处理中'], ['failed', '失败']] as const).map(([key, label]) => (
            <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}{key === 'failed' && failedCount ? <Tag tone="red">{failedCount}</Tag> : null}{key === 'active' && activeCount ? <Tag tone="blue">{activeCount}</Tag> : null}</button>
          ))}
        </div>
        <span className="grow" />
        <div className="search-box" style={{ width: 240 }}><Search size={15} /><input className="input sm" aria-label="搜索文件名" placeholder="搜索文件名" value={q} onChange={(event) => setQ(event.target.value)} /></div>
      </div>
      {!files ? <Loading /> : null}
      {files && !files.length ? <Empty icon={<Upload size={26} />} title="还没有数据" desc="导入文件、网页或文本后会在这里看到处理进度和分块。" action={<button className="btn primary" onClick={() => navigate(`/knowledge/${kb.id}/import`)}>导入数据</button>} /> : null}
      {rows.length ? (
        <table className="table">
          <thead><tr><th>名称</th><th>切块方式</th><th>分块数</th><th>状态</th><th>更新时间</th><th style={{ width: 200 }}>操作</th></tr></thead>
          <tbody>
            {rows.map((file) => {
              const job = latestJob[file.id];
              const status = FILE_STATUS[file.status] ?? { label: file.status, tone: '' };
              const method = (file.chunk_config?.method ?? kb.chunk_method) as ApiChunkConfig['method'];
              return (
                <tr key={file.id} className={file.status === 'completed' ? 'clickable' : undefined} title={file.status === 'completed' ? '查看分块' : '处理完成后可查看分块'} onClick={() => file.status === 'completed' && navigate(`/knowledge/${kb.id}/files/${file.id}`)}>
                  <td><div className="row"><FileIcon file={file} /><div><div style={{ fontWeight: 500 }}>{file.filename}</div><div className="faint">{formatBytes(file.size_bytes)}{file.page_count ? ` · ${file.page_count} 页` : ''}</div></div></div></td>
                  <td><Tag tone="blue">{METHOD_LABEL[method] ?? method}</Tag></td>
                  <td>{file.chunk_count || '—'}</td>
                  <td>
                    {isActive(file) && job ? (
                      <div style={{ width: 140 }}><div className="row faint" style={{ marginBottom: 4 }}><Spinner size={12} />{STAGE_LABEL[job.current_stage] ?? job.current_stage} {job.progress}%</div><div className="progress"><i style={{ width: `${job.progress}%` }} /></div></div>
                    ) : <div><Tag tone={status.tone}>{file.status === 'failed' ? <AlertCircle size={12} /> : null}{status.label}</Tag>{file.error_message ? <div className="faint clamp-2" style={{ marginTop: 4, maxWidth: 260 }}>{file.error_message}</div> : null}</div>}
                  </td>
                  <td className="faint">{formatTime(file.updated_at)}</td>
                  <td onClick={(event) => event.stopPropagation()}>
                    <div className="row" style={{ gap: 2 }}>
                      {file.status === 'failed' && !isActive(file) ? <button className="btn sm" disabled={busy === file.id} onClick={() => void retry(file)}>{busy === file.id ? <Spinner size={12} /> : null}重试</button> : null}
                      <button className="btn sm ghost" disabled={isActive(file)} onClick={() => setRechunk({ file, config: { ...defaultChunkConfig(kb), ...file.chunk_config } })}>重新切块</button>
                      <button className="btn sm ghost icon" aria-label="元数据" title="元数据" disabled={!file.document_metadata?.extraction_status} onClick={() => setMeta(file)}><Tags size={14} /></button>
                      <button className="btn sm ghost icon" aria-label={`删除 ${file.filename}`} title="删除" onClick={() => setRemoving(file)}><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : files?.length ? <Empty title="没有符合条件的文件" /> : null}

      <Modal open={!!rechunk} wide title={`重新切块：${rechunk?.file.filename ?? ''}`} onClose={() => setRechunk(null)}
        footer={<><button className="btn" onClick={() => setRechunk(null)}>取消</button><button className="btn primary" disabled={!!rechunkProblem || busy === rechunk?.file.id} onClick={async () => { if (rechunk && await retry(rechunk.file, rechunk.config, rechunk.discardEdits)) setRechunk(null); }}>确认重新切块</button></>}>
        {rechunk ? <>
          <p className="muted" style={{ marginBottom: 8 }}>会重新解析该文件并替换它的分块与向量；人工编辑过的元数据会保留。</p>
          <label className="row" style={{ gap: 8, marginBottom: 12, fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={!rechunk.discardEdits} onChange={(event) => setRechunk({ ...rechunk, discardEdits: !event.target.checked })} />
            <span>保留人工编辑过的分块<span className="faint">（顶替新切块中对应的位置，找不到对应位置的放在末尾）</span></span>
          </label>
          <MethodPicker kb={kb} value={rechunk.config.method} recommended={recommendedMethod(rechunk.file.filename).method} onChange={(method) => setRechunk({ ...rechunk, config: { ...rechunk.config, method } })} />
          <div style={{ marginTop: 16 }}><ChunkConfigFields kb={kb} config={rechunk.config} patch={(patch) => setRechunk({ ...rechunk, config: { ...rechunk.config, ...patch } })} /></div>
          {rechunkProblem ? <Notice tone="error">{rechunkProblem}</Notice> : null}
        </> : null}
      </Modal>

      <ConfirmModal open={!!removing} danger title="删除文件" confirmText="删除" body={<>将删除「{removing?.filename}」及其全部分块和向量，引用本库的应用将无法再检索到这些内容。</>}
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await apiFetch(`/knowledge-bases/${kb.id}/files/${removing.id}`, { method: 'DELETE' });
            toast('文件已删除');
            await load();
            onChanged();
          } catch (caught) { toast(errorMessage(caught), 'error'); }
        }} />

      <MetadataDrawer kb={kb} file={meta} onClose={() => setMeta(null)} onSaved={() => void load()} />
    </div>
  );
}

function MetadataDrawer({ kb, file, onClose, onSaved }: { kb: ApiKnowledgeBase; file: ApiKnowledgeFile | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState({ document_time: '', version: '', owner: '', subjects: '', keywords: '', likely_questions: '' });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const value = file?.document_metadata ?? {};
    setDraft({
      document_time: value.document_time ?? '', version: value.version ?? '', owner: value.owner ?? '',
      subjects: (value.subjects ?? []).join('、'), keywords: (value.keywords ?? []).join('、'), likely_questions: (value.likely_questions ?? []).join('\n'),
    });
  }, [file]);
  const list = (text: string) => text.split(/[\n,，、]+/).map((item) => item.trim()).filter(Boolean);
  return (
    <Drawer open={!!file} title="文件元数据" onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy} onClick={async () => {
        if (!file) return;
        setBusy(true);
        try {
          await apiFetch(`/knowledge-bases/${kb.id}/files/${file.id}/metadata`, { method: 'PATCH', body: JSON.stringify({ document_time: draft.document_time || null, version: draft.version || null, owner: draft.owner || null, subjects: list(draft.subjects), keywords: list(draft.keywords), likely_questions: list(draft.likely_questions) }) });
          toast('元数据已保存，相关分块会重新向量化');
          onSaved();
          onClose();
        } catch (caught) { toast(errorMessage(caught), 'error'); } finally { setBusy(false); }
      }}>保存</button></>}>
      {file ? <>
        <p className="faint" style={{ marginBottom: 12 }}>{file.filename} · 抽取方式：{file.document_metadata?.extraction_method === 'llm' ? '模型抽取' : file.document_metadata?.extraction_method === 'manual' ? '人工编辑' : '规则抽取'}</p>
        <div className="form-grid">
          <Field label="时间"><input className="input" value={draft.document_time} onChange={(event) => setDraft({ ...draft, document_time: event.target.value })} /></Field>
          <Field label="版本"><input className="input" value={draft.version} onChange={(event) => setDraft({ ...draft, version: event.target.value })} /></Field>
        </div>
        <Field label="负责人 / 部门"><input className="input" value={draft.owner} onChange={(event) => setDraft({ ...draft, owner: event.target.value })} /></Field>
        <Field label="主体"><input className="input" value={draft.subjects} onChange={(event) => setDraft({ ...draft, subjects: event.target.value })} /></Field>
        <Field label="检索关键词"><textarea className="textarea" value={draft.keywords} onChange={(event) => setDraft({ ...draft, keywords: event.target.value })} /></Field>
        <Field label="可能被问到的问题" hint="每行一个，会加入分块的检索文本"><textarea className="textarea" style={{ minHeight: 120 }} value={draft.likely_questions} onChange={(event) => setDraft({ ...draft, likely_questions: event.target.value })} /></Field>
      </> : null}
    </Drawer>
  );
}

/* ------------------------------ 分块管理 ------------------------------ */

type QAPair = { q: string; a: string };
const keywordsOf = (chunk: ApiChunk) => (Array.isArray(chunk.metadata_json.keywords) ? chunk.metadata_json.keywords as string[] : []);
const qaOf = (chunk: ApiChunk) => (Array.isArray(chunk.metadata_json.qa_pairs) ? chunk.metadata_json.qa_pairs as QAPair[] : []);

function ChunksView({ kb }: { kb: ApiKnowledgeBase }) {
  const { fileId = '' } = useParams();
  const toast = useToast();
  const [file, setFile] = useState<ApiKnowledgeFile | null>(null);
  const [chunks, setChunks] = useState<ApiChunk[] | null>(null);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<ApiChunk | null>(null);
  const [draft, setDraft] = useState<{ title: string; content: string; keywords: string; qa_pairs: QAPair[] }>({ title: '', content: '', keywords: '', qa_pairs: [] });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([apiFetch<ApiKnowledgeFile[]>(`/knowledge-bases/${kb.id}/files`), apiFetch<ApiChunk[]>(`/knowledge-bases/${kb.id}/chunks?file_id=${fileId}`)])
      .then(([files, loaded]) => { setFile(files.find((item) => item.id === fileId) ?? null); setChunks(loaded); })
      .catch((caught) => toast(errorMessage(caught), 'error'));
  }, [kb.id, fileId, toast]);

  const list = (chunks ?? []).filter((chunk) => !q || chunk.content.includes(q) || chunk.title.includes(q));
  const method = (file?.chunk_config?.method ?? kb.chunk_method) as ApiChunkConfig['method'];

  return (
    <div className="page">
      <div className="row faint" style={{ marginBottom: 8 }}><Link to={`/knowledge/${kb.id}`}>数据集</Link><ChevronRight size={13} /><span>{file?.filename ?? '文件'}</span></div>
      <div className="page-head">
        <div className="grow">
          <h1>{file?.filename ?? '分块'}</h1>
          <div className="row wrap" style={{ marginTop: 8 }}>
            <Tag tone="blue">{METHOD_LABEL[method] ?? method}</Tag>
            {file?.chunk_config ? <Tag>块大小 {file.chunk_config.chunk_size} · 重叠 {file.chunk_config.chunk_overlap}</Tag> : null}
            <span className="faint">共 {chunks?.length ?? 0} 块</span>
          </div>
        </div>
      </div>
      <div className="search-box" style={{ maxWidth: 360, marginBottom: 14 }}><Search size={15} /><input className="input sm" aria-label="搜索分块内容" placeholder="搜索分块内容" value={q} onChange={(event) => setQ(event.target.value)} /></div>
      {!chunks ? <Loading /> : null}
      {chunks && !list.length ? <Empty title="没有分块" /> : null}
      <div className="grid c2" style={{ gap: 12 }}>
        {list.map((chunk) => (
          <button key={chunk.id} className="chunk-card" style={{ textAlign: 'left', cursor: 'pointer' }} onClick={() => { setEditing(chunk); setDraft({ title: chunk.title, content: chunk.content, keywords: keywordsOf(chunk).join('、'), qa_pairs: qaOf(chunk) }); }}>
            <header><span className="idx">#{chunk.ordinal}</span><span className="ellipsis grow">{chunk.title}</span>{chunk.page_number ? <span>第 {chunk.page_number} 页</span> : null}<span>{chunk.char_count} 字</span>{chunk.metadata_json.manual_edit ? <Tag tone="green">人工编辑</Tag> : null}{chunk.indexed ? null : <Tag tone="orange">未向量化</Tag>}</header>
            <div className="body clamp-3">{chunk.content}</div>
            {keywordsOf(chunk).length ? <div className="row wrap" style={{ gap: 4, marginTop: 6 }}>{keywordsOf(chunk).map((word) => <Tag key={word}>{word}</Tag>)}</div> : null}
            {qaOf(chunk).length ? <div className="faint" style={{ marginTop: 6 }}>问答对 {qaOf(chunk).length} 组 · {qaOf(chunk)[0].q}{qaOf(chunk).length > 1 ? ' …' : ''}</div> : null}
            {chunk.metadata_json.parent_content ? <div className="faint" style={{ marginTop: 6 }}>父块 {String(chunk.metadata_json.parent_content).length} 字</div> : null}
          </button>
        ))}
      </div>
      <Drawer open={!!editing} title={`编辑分块 #${editing?.ordinal ?? ''}`} onClose={() => setEditing(null)}
        footer={<><button className="btn" onClick={() => setEditing(null)}>取消</button><button className="btn primary" disabled={busy || !draft.content.trim()} onClick={async () => {
          if (!editing) return;
          setBusy(true);
          try {
            const updated = await apiFetch<ApiChunk>(`/knowledge-bases/${kb.id}/chunks/${editing.id}`, { method: 'PATCH', body: JSON.stringify({
              title: draft.title, content: draft.content,
              keywords: draft.keywords.split(/[\n,，、]+/).map((item) => item.trim()).filter(Boolean),
              qa_pairs: draft.qa_pairs.map((item) => ({ q: item.q.trim(), a: item.a.trim() })).filter((item) => item.q && item.a),
            }) });
            setChunks((current) => current?.map((item) => (item.id === updated.id ? updated : item)) ?? null);
            toast('分块已保存，向量已更新');
            setEditing(null);
          } catch (caught) { toast(errorMessage(caught), 'error'); } finally { setBusy(false); }
        }}>{busy ? <Spinner /> : null}保存</button></>}>
        <Field label="标题"><input className="input" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></Field>
        <Field label="内容" hint={`${draft.content.length} 字`}><textarea className="textarea" style={{ minHeight: 220 }} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></Field>
        <Field label="关键词" hint="顿号或逗号分隔，参与检索"><input className="input" value={draft.keywords} onChange={(event) => setDraft({ ...draft, keywords: event.target.value })} /></Field>
        <Field label="问答对" hint="用户可能怎么问、本块怎么答；问题会参与检索">
          <div className="col" style={{ gap: 8 }}>
            {draft.qa_pairs.map((pair, index) => (
              <div key={index} className="card" style={{ padding: 10 }}>
                <div className="row"><input className="input sm" placeholder="问题" value={pair.q} onChange={(event) => setDraft({ ...draft, qa_pairs: draft.qa_pairs.map((item, i) => (i === index ? { ...item, q: event.target.value } : item)) })} /><button type="button" className="btn ghost sm icon" aria-label="删除问答对" onClick={() => setDraft({ ...draft, qa_pairs: draft.qa_pairs.filter((_, i) => i !== index) })}><Trash2 size={13} /></button></div>
                <textarea className="textarea" style={{ minHeight: 56, marginTop: 6 }} placeholder="答案" value={pair.a} onChange={(event) => setDraft({ ...draft, qa_pairs: draft.qa_pairs.map((item, i) => (i === index ? { ...item, a: event.target.value } : item)) })} />
              </div>
            ))}
            <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} disabled={draft.qa_pairs.length >= 10} onClick={() => setDraft({ ...draft, qa_pairs: [...draft.qa_pairs, { q: '', a: '' }] })}>添加问答对</button>
          </div>
        </Field>
        {editing?.metadata_json.parent_content ? <Field label="父块（命中后返回给模型）"><div className="json-view">{String(editing.metadata_json.parent_content)}</div></Field> : null}
      </Drawer>
    </div>
  );
}

/* ------------------------------ 检索测试 ------------------------------ */

type Mode = 'semantic' | 'fulltext' | 'hybrid';

function SearchView({ kb, usedBy }: { kb: ApiKnowledgeBase; usedBy: FDEApp[] }) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>(kb.embedding_model_id ? 'hybrid' : 'fulltext');
  const [topK, setTopK] = useState(8);
  const [rerankN, setRerankN] = useState(3);
  const [threshold, setThreshold] = useState(0);
  const [result, setResult] = useState<ApiRetrievalResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);
  const [targets, setTargets] = useState<string[]>([]);
  const [applyBusy, setApplyBusy] = useState(false);

  // 把当前测试参数写入应用草稿的「检索参数」，线上版本需重新发布才生效
  const applyToApps = async () => {
    setApplyBusy(true);
    try {
      for (const id of targets) {
        const app = await fdeApi.get(id);
        await fdeApi.save(id, withRetrievalConfig(app.manifest, { mode, top_k: topK, rerank_top_n: Math.min(rerankN, topK), score_threshold: threshold }));
      }
      toast(`已写入 ${targets.length} 个应用的草稿，发布后线上生效`);
      setApplying(false);
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setApplyBusy(false);
    }
  };

  const run = async (text = query) => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      setResult(await apiFetch<ApiRetrievalResponse>(`/knowledge-bases/${kb.id}/retrieval-test`, { method: 'POST', body: JSON.stringify({ query: text.trim(), mode, top_k: topK, rerank_top_n: Math.min(rerankN, topK), score_threshold: threshold }) }));
      setHistory((items) => [text.trim(), ...items.filter((item) => item !== text.trim())].slice(0, 6));
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  };

  // 中文问题通常没有空格：按标点切词，再把较长的中文片段拆成双字词，用于命中高亮
  const words = useMemo(() => {
    const terms = query.trim().split(/[\s,，。？?！!、；;：:]+/).filter((item) => item.length > 1);
    const grams = terms.flatMap((term) => (/^[\u4e00-\u9fff]{3,}$/.test(term) ? Array.from({ length: term.length - 1 }, (_, index) => term.slice(index, index + 2)) : [term]));
    return Array.from(new Set(grams)).sort((a, b) => b.length - a.length);
  }, [query]);
  const highlight = (text: string) => {
    if (!words.length) return text;
    const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'g');
    return text.split(re).map((part, index) => (words.includes(part) ? <mark key={index} style={{ background: C.markBg, padding: '0 2px', borderRadius: 3 }}>{part}</mark> : part));
  };

  return (
    <div className="page" style={{ display: 'flex', gap: 24, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      <div style={{ width: 380, maxWidth: '100%', flex: 'none' }}>
        <h1 style={{ fontSize: 20, fontWeight: 600 }}>检索测试</h1>
        <p className="muted" style={{ margin: '4px 0 16px' }}>用真实问题验证召回效果；调好后可一键写入引用本库的应用。</p>
        <div className="card pad">
          <textarea className="textarea" aria-label="测试问题" placeholder="输入一个用户可能会问的问题" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void run(); }} />
          <Field label="检索模式">
            <div className="seg" style={{ width: '100%' }}>
              {([['semantic', '语义'], ['fulltext', '全文'], ['hybrid', '混合']] as const).map(([key, label]) => <button key={key} style={{ flex: 1 }} disabled={key !== 'fulltext' && !kb.embedding_model_id} className={mode === key ? 'active' : ''} onClick={() => setMode(key)}>{label}</button>)}
            </div>
            <p className="faint" style={{ marginTop: 6 }}>{mode === 'semantic' ? '按语义相似度召回，擅长同义表达。' : mode === 'fulltext' ? '按关键词匹配，擅长编号、型号、条款号。' : '语义与全文并行召回，RRF 融合排序。'}</p>
          </Field>
          <Field label="初召回数量"><Slider label="初召回数量" value={topK} min={1} max={50} onChange={setTopK} /></Field>
          <Field label="重排后保留" hint={kb.rerank_model_id ? '已配置重排模型' : '未配置重排模型'}><Slider label="重排后保留" value={rerankN} min={1} max={20} onChange={setRerankN} /></Field>
          <Field label="最低相关度"><Slider label="最低相关度" value={threshold} min={0} max={1} step={0.05} onChange={setThreshold} /></Field>
          <button className="btn primary" style={{ width: '100%' }} disabled={busy || !query.trim()} onClick={() => void run()}>{busy ? <Spinner /> : <Search size={15} />}测试</button>
          <button className="btn ghost" style={{ width: '100%', marginTop: 8 }} disabled={!usedBy.length} title={usedBy.length ? undefined : '还没有应用引用本库'} onClick={() => { setTargets(usedBy.map((app) => app.id)); setApplying(true); }}>把这组参数用到应用</button>
        </div>
        {history.length ? <><div className="section-title" style={{ fontSize: 13 }}>本次测试历史</div>{history.map((item) => <button key={item} className="sub-link" onClick={() => { setQuery(item); void run(item); }}><Search size={13} className="muted" />{item}</button>)}</> : null}
      </div>
      <div className="grow" style={{ minWidth: 320 }}>
        {result ? <>
          <div className="row wrap" style={{ marginBottom: 12, marginTop: 4 }}>
            <strong>召回结果</strong><Tag>{mode === 'semantic' ? '语义检索' : mode === 'fulltext' ? '全文检索' : '混合检索'}</Tag>
            <span className="faint">召回 {result.recalled_count} 条 · 返回 {result.returned_count} 条 · 耗时 {result.total_duration_ms}ms{result.rerank_applied ? ' · 已重排' : ''}</span>
            {result.simulated ? <Tag tone="orange">测试替身</Tag> : null}
          </div>
          {!result.results.length ? <Empty title="没有达到阈值的结果" desc="可以降低最低相关度，或换用混合检索。" /> : null}
          <div className="col" style={{ gap: 12 }}>
            {result.results.map((item, index) => (
              <div key={item.chunk_id} className="chunk-card">
                <header>
                  <span className="idx">TOP {index + 1}</span>
                  {item.vector_score ? <Tag tone="blue">语义 <span className="score">{item.vector_score.toFixed(3)}</span></Tag> : null}
                  {item.keyword_score != null ? <Tag tone="teal">全文 <span className="score">{item.keyword_score.toFixed(3)}</span></Tag> : null}
                  {item.rerank_score != null ? <Tag tone="green">重排 <span className="score">{item.rerank_score.toFixed(3)}</span></Tag> : null}
                  <Tag tone="purple">综合 <span className="score">{item.final_score.toFixed(3)}</span></Tag>
                  <span className="grow" /><span className="ellipsis">{item.filename}{item.page_number ? ` · 第 ${item.page_number} 页` : ''}</span>
                </header>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 4 }}>{item.title}</div>
                <div className="body">{highlight(item.content)}</div>
              </div>
            ))}
          </div>
        </> : <Empty icon={<FlaskConical size={26} />} title="输入问题开始测试" desc="对比不同检索模式下的召回差异，编号类问题建议用混合或全文检索。" />}
      </div>
      <Modal open={applying} title="把检索参数用到应用" onClose={() => setApplying(false)}
        footer={<><button className="btn" onClick={() => setApplying(false)}>取消</button><button className="btn primary" disabled={applyBusy || !targets.length} onClick={() => void applyToApps()}>{applyBusy ? <Spinner /> : null}写入草稿</button></>}>
        <p className="muted" style={{ marginBottom: 12 }}>{({ semantic: '语义', fulltext: '全文', hybrid: '混合' } as const)[mode]}检索 · 初召回 {topK} · 重排保留 {Math.min(rerankN, topK)} · 最低相关度 {threshold}</p>
        <div className="col" style={{ gap: 6 }}>
          {usedBy.map((app) => (
            <label key={app.id} className="row" style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
              <input type="checkbox" checked={targets.includes(app.id)} onChange={(event) => setTargets(event.target.checked ? [...targets, app.id] : targets.filter((item) => item !== app.id))} />
              <span className="grow">{app.name}</span>{app.manifest.knowledge_base_ids.length > 1 ? <span className="faint">同时引用 {app.manifest.knowledge_base_ids.length} 个知识库</span> : null}
            </label>
          ))}
        </div>
        <p className="faint" style={{ marginTop: 10 }}>参数作用于应用的全部知识库，只修改草稿；重新发布后线上生效。</p>
      </Modal>
    </div>
  );
}

/* ------------------------------ 配置 ------------------------------ */

function SettingsView({ kb, onSaved, usedBy }: { kb: ApiKnowledgeBase; onSaved: (kb: ApiKnowledgeBase) => void; usedBy: FDEApp[] }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [options, setOptions] = useState<ApiModelOption[]>([]);
  const [draft, setDraft] = useState({ ...kb });
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [rebuild, setRebuild] = useState(false);
  useEffect(() => { apiFetch<ApiModelOption[]>('/model-options').then(setOptions).catch(() => undefined); }, []);
  useEffect(() => setDraft({ ...kb }), [kb]);

  const select = (key: 'embedding_model_id' | 'rerank_model_id' | 'ocr_model_id' | 'semantic_llm_model_id' | 'metadata_llm_model_id', type: ApiModelOption['model_type'], empty?: string) => (
    <select className="select" value={draft[key] ?? ''} onChange={(event) => setDraft({ ...draft, [key]: event.target.value || null })}>
      {empty ? <option value="">{empty}</option> : null}
      {modelsOf(options, type).map((model) => <option key={model.id} value={model.id}>{model.display_name} · {model.provider}</option>)}
    </select>
  );
  const embeddingChanged = draft.embedding_model_id !== kb.embedding_model_id;
  const sizeProblem = draft.chunk_overlap >= draft.chunk_size ? '重叠长度必须小于块大小' : draft.chunk_size < 100 || draft.chunk_size > 4000 ? '块大小需在 100–4000 之间' : null;

  const save = async () => {
    setBusy(true);
    try {
      const updated = await apiFetch<ApiKnowledgeBase>(`/knowledge-bases/${kb.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: draft.name, description: draft.description, embedding_model_id: draft.embedding_model_id, rerank_model_id: draft.rerank_model_id,
          ocr_model_id: draft.ocr_model_id, semantic_llm_model_id: draft.semantic_llm_model_id, metadata_llm_model_id: draft.metadata_llm_model_id,
          chunk_method: draft.chunk_method, chunk_size: draft.chunk_size, chunk_overlap: draft.chunk_overlap,
        }),
      });
      onSaved(updated);
      toast('配置已保存');
      // 索引模型变了，旧向量已不可用：直接询问是否立即重建
      if (embeddingChanged && kb.file_count) setRebuild(true);
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 880 }}>
      <div className="page-head"><div className="grow"><h1>配置</h1><p>新导入文件的默认设置；已导入的文件保留各自的切块方式。</p></div><button className="btn primary" disabled={busy || !draft.name.trim() || !!sizeProblem} onClick={() => void save()}>{busy ? <Spinner /> : null}保存</button></div>
      <div className="card pad">
        <div className="section-title" style={{ marginTop: 0 }}>基础信息</div>
        <Field label="名称" required><input className="input" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
        <Field label="简介" hint="Agent 依据简介判断何时检索本库"><textarea className="textarea" style={{ minHeight: 60 }} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></Field>
      </div>
      <div className="card pad" style={{ marginTop: 16 }}>
        <div className="section-title" style={{ marginTop: 0 }}>模型</div>
        <div className="form-grid">
          <Field label="索引模型" hint="变更后需重建">{select('embedding_model_id', 'embedding', '不使用（仅全文检索）')}</Field>
          <Field label="重排模型">{select('rerank_model_id', 'rerank', '不使用')}</Field>
          <Field label="语义分块模型">{select('semantic_llm_model_id', 'llm', '不使用')}</Field>
          <Field label="元数据抽取 / 问答对生成模型">{select('metadata_llm_model_id', 'llm', '规则抽取')}</Field>
          <Field label="图片理解 / OCR">{select('ocr_model_id', 'ocr', '不处理图片')}</Field>
        </div>
        {embeddingChanged ? <Notice tone="warn">索引模型变更后，已有向量与新模型不兼容，需要「重建全部索引」后检索才会恢复。</Notice> : null}
      </div>
      <div className="card pad" style={{ marginTop: 16 }}>
        <div className="section-title" style={{ marginTop: 0 }}>新文件默认切块</div>
        <MethodPicker kb={draft} value={draft.chunk_method} onChange={(method) => setDraft({ ...draft, chunk_method: method })} />
        {sizeProblem ? <div style={{ marginTop: 12 }}><Notice tone="error">{sizeProblem}</Notice></div> : null}
        <div className="form-grid" style={{ marginTop: 14 }}>
          <Field label="块大小"><input className="input" type="number" min={100} max={4000} value={draft.chunk_size} onChange={(event) => setDraft({ ...draft, chunk_size: Number(event.target.value) })} /></Field>
          <Field label="重叠长度"><input className="input" type="number" min={0} max={1000} value={draft.chunk_overlap} onChange={(event) => setDraft({ ...draft, chunk_overlap: Number(event.target.value) })} /></Field>
        </div>
      </div>
      <div className="card pad row" style={{ marginTop: 16 }}>
        <div className="grow"><strong>重建全部索引</strong><div className="faint">按每个文件各自的切块配置重新解析和向量化；构建中旧分块会被替换。</div></div>
        <button className="btn" onClick={() => setRebuild(true)}><RefreshCw size={14} />重建</button>
      </div>
      <div className="card pad row" style={{ marginTop: 16, borderColor: C.dangerSoft }}>
        <div className="grow"><strong>删除知识库</strong><div className="faint">删除 {kb.file_count} 个文件和全部索引{usedBy.length ? `，${usedBy.length} 个应用正在引用` : ''}。</div></div>
        <button className="btn danger" onClick={() => setRemoving(true)}><Trash2 size={14} />删除</button>
      </div>
      <ConfirmModal open={rebuild} title="重建全部索引" body={`将为 ${kb.file_count} 个文件重新执行解析、切块和向量化，可能产生模型调用费用。索引模型变更后需重建，检索才会恢复。`} confirmText="开始重建" onClose={() => setRebuild(false)}
        onConfirm={async () => { try { await apiFetch(`/knowledge-bases/${kb.id}/rebuild`, { method: 'POST' }); toast('已开始重建'); navigate(`/knowledge/${kb.id}`); } catch (caught) { toast(errorMessage(caught), 'error'); } }} />
      <ConfirmModal open={removing} danger title="删除知识库" confirmText="永久删除" body={<>确定删除「{kb.name}」？此操作不可恢复。{usedBy.length ? <div style={{ marginTop: 8 }}><Notice tone="warn" title={`${usedBy.length} 个应用正在引用本库`}>{usedBy.map((app) => app.name).join('、')}——删除后它们将失去该知识来源，请先在应用中移除或替换。</Notice></div> : null}</>} onClose={() => setRemoving(false)}
        onConfirm={async () => { try { await apiFetch(`/knowledge-bases/${kb.id}`, { method: 'DELETE' }); toast('知识库已删除'); navigate('/knowledge'); } catch (caught) { toast(errorMessage(caught), 'error'); } }} />
    </div>
  );
}
