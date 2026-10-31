import { Check, Copy, KeyRound, Minus, Plus, ScrollText, Search, ShieldCheck, Trash2, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiFetch, errorMessage } from '../api/client';
import { useAuth } from '../auth';
import { ConfirmModal, Empty, Field, Loading, Modal, Notice, Spinner, Tag, formatTime, useToast } from '../components/ui';
import type { Role } from '../types';

type Tab = 'members' | 'roles' | 'tokens' | 'audit';
type AuditEvent = { id: string; actor_name: string; action: string; resource_type: string; resource_id: string | null; detail: Record<string, unknown>; created_at: string };
type Member = { id: string; email: string; display_name: string; is_active: boolean; role: Role; joined_at: string };
type ApiClientItem = { id: string; name: string; role: 'admin' | 'manager'; scopes: string[]; last_used_at: string | null };

const ROLE_LABEL: Record<Role, string> = { admin: '管理员', manager: '应用管理员', user: '业务使用者' };
const SCOPES: Array<[string, string]> = [
  ['apps:run', '运行应用'], ['apps:read', '读取应用'], ['apps:write', '修改应用'], ['apps:evaluate', '运行评测'],
  ['knowledge:read', '读取知识库'], ['knowledge:write', '写入知识库'], ['models:read', '读取模型'], ['tools:read', '读取工具'], ['tools:write', '修改工具'], ['logs:read', '读取日志'],
];

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab: Tab = requested === 'roles' || requested === 'tokens' || requested === 'audit' ? requested : 'members';
  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <div className="page-head"><div className="grow"><h1>设置</h1><p>管理业务空间成员、业务系统调用用的 API Token，并查看操作审计。</p></div></div>
      <div className="seg" style={{ marginBottom: 16 }}>
        <button className={tab === 'members' ? 'active' : ''} onClick={() => setParams({ tab: 'members' })}><Users size={14} />成员</button>
        <button className={tab === 'roles' ? 'active' : ''} onClick={() => setParams({ tab: 'roles' })}><ShieldCheck size={14} />角色与权限</button>
        <button className={tab === 'tokens' ? 'active' : ''} onClick={() => setParams({ tab: 'tokens' })}><KeyRound size={14} />API Token</button>
        <button className={tab === 'audit' ? 'active' : ''} onClick={() => setParams({ tab: 'audit' })}><ScrollText size={14} />审计日志</button>
      </div>
      {tab === 'members' ? <MembersView /> : tab === 'roles' ? <RolesView /> : tab === 'tokens' ? <TokensView /> : <AuditView />}
    </div>
  );
}

function MembersView() {
  const toast = useToast();
  const { me } = useAuth();
  const [items, setItems] = useState<Member[] | null>(null);
  const [error, setError] = useState('');
  const [inviting, setInviting] = useState(false);
  const [form, setForm] = useState({ email: '', display_name: '', password: '', role: 'user' as Role });
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);

  const load = useCallback(() => apiFetch<Member[]>('/auth/users').then((list) => { setItems(list); setError(''); }).catch((caught) => setError(errorMessage(caught))), []);
  useEffect(() => { void load(); }, [load]);

  const invite = async () => {
    setBusy(true);
    try {
      await apiFetch('/auth/users', { method: 'POST', body: JSON.stringify({ ...form, email: form.email.trim(), display_name: form.display_name.trim() }) });
      toast('成员已加入');
      setInviting(false);
      setForm({ email: '', display_name: '', password: '', role: 'user' });
      await load();
    } catch (caught) { toast(errorMessage(caught), 'error'); } finally { setBusy(false); }
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}><span className="grow" /><button className="btn primary" onClick={() => setInviting(true)}><Plus size={15} />添加成员</button></div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!items && !error ? <Loading /> : null}
      {items?.length ? (
        <table className="table">
          <thead><tr><th>成员</th><th>角色</th><th>加入时间</th><th /></tr></thead>
          <tbody>{items.map((member) => {
            const self = member.id === me?.user?.id;
            return (
              <tr key={member.id}>
                <td><strong>{member.display_name}</strong>{self ? <Tag tone="blue">我</Tag> : null}<div className="faint">{member.email}</div></td>
                <td><select className="select sm" style={{ width: 140 }} aria-label={`${member.display_name} 的角色`} value={member.role} disabled={self} onChange={async (event) => { try { await apiFetch(`/auth/users/${member.id}`, { method: 'PATCH', body: JSON.stringify({ role: event.target.value }) }); toast('角色已更新'); await load(); } catch (caught) { toast(errorMessage(caught), 'error'); } }}>{Object.entries(ROLE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></td>
                <td className="faint">{formatTime(member.joined_at)}</td>
                <td>{self ? null : <button className="btn sm ghost icon" aria-label={`移除 ${member.display_name}`} onClick={() => setRemoving(member)}><Trash2 size={14} /></button>}</td>
              </tr>
            );
          })}</tbody>
        </table>
      ) : null}
      <Modal open={inviting} title="添加成员" onClose={() => setInviting(false)} footer={<><button className="btn" onClick={() => setInviting(false)}>取消</button><button className="btn primary" disabled={busy || !form.email.includes('@') || !form.display_name.trim() || form.password.length < 8} onClick={() => void invite()}>{busy ? <Spinner /> : null}添加</button></>}>
        <Field label="邮箱" required><input className="input" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></Field>
        <Field label="姓名" required><input className="input" value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} /></Field>
        <Field label="初始密码" required hint="至少 8 位；已有账号的用户沿用原密码"><input className="input" type="password" autoComplete="new-password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
        <Field label="角色"><select className="select" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as Role })}>{Object.entries(ROLE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
      </Modal>
      <ConfirmModal open={!!removing} danger title="移出成员" confirmText="移出" body={<>「{removing?.display_name}」将无法再访问当前业务空间。</>} onClose={() => setRemoving(null)}
        onConfirm={async () => { if (!removing) return; try { await apiFetch(`/auth/users/${removing.id}`, { method: 'DELETE' }); toast('已移出'); await load(); } catch (caught) { toast(errorMessage(caught), 'error'); } }} />
    </>
  );
}

function TokensView() {
  const toast = useToast();
  const [items, setItems] = useState<ApiClientItem[] | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', role: 'manager' as 'admin' | 'manager', scopes: ['apps:run'] });
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<ApiClientItem | null>(null);

  const load = useCallback(() => apiFetch<ApiClientItem[]>('/auth/api-clients').then((list) => { setItems(list); setError(''); }).catch((caught) => setError(errorMessage(caught))), []);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    setBusy(true);
    try {
      const result = await apiFetch<{ token: string }>('/auth/api-clients', { method: 'POST', body: JSON.stringify({ ...form, name: form.name.trim() }) });
      setCreated(result.token);
      await load();
    } catch (caught) { toast(errorMessage(caught), 'error'); } finally { setBusy(false); }
  };
  const close = () => { setCreating(false); setCreated(null); setForm({ name: '', role: 'manager', scopes: ['apps:run'] }); };
  const copy = (text: string) => { void navigator.clipboard?.writeText(text); toast('已复制'); };

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}><p className="faint grow">业务系统调用应用或推送知识库文件时使用。Token 只在创建时显示一次。</p><button className="btn primary" onClick={() => setCreating(true)}><Plus size={15} />创建 Token</button></div>
      {error ? <Notice tone="error">{error}</Notice> : null}
      {!items && !error ? <Loading /> : null}
      {items && !items.length ? <Empty icon={<KeyRound size={26} />} title="还没有 API Token" /> : null}
      {items?.length ? (
        <table className="table">
          <thead><tr><th>名称</th><th>角色</th><th>权限</th><th>最近使用</th><th /></tr></thead>
          <tbody>{items.map((item) => (
            <tr key={item.id}>
              <td><strong>{item.name}</strong></td>
              <td><Tag>{ROLE_LABEL[item.role]}</Tag></td>
              <td><div className="row wrap" style={{ gap: 4 }}>{item.scopes.map((scope) => <Tag key={scope}>{scope}</Tag>)}</div></td>
              <td className="faint">{item.last_used_at ? formatTime(item.last_used_at) : '从未使用'}</td>
              <td><button className="btn sm ghost" onClick={() => setRevoking(item)}><Trash2 size={13} />吊销</button></td>
            </tr>
          ))}</tbody>
        </table>
      ) : null}
      <Modal open={creating} title="创建 API Token" onClose={close}
        footer={created ? <button className="btn primary" onClick={close}>完成</button> : <><button className="btn" onClick={close}>取消</button><button className="btn primary" disabled={busy || !form.name.trim() || !form.scopes.length} onClick={() => void create()}>{busy ? <Spinner /> : null}创建</button></>}>
        {created ? <>
          <Notice tone="success" title="Token 已创建">请立即复制保存，关闭后无法再次查看。</Notice>
          <div className="row" style={{ marginTop: 12 }}><input className="input mono" readOnly value={created} /><button className="btn" onClick={() => copy(created)}><Copy size={14} />复制</button></div>
        </> : <>
          <Field label="名称" required><input className="input" value={form.name} placeholder="例如：客服系统" onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
          <Field label="角色"><select className="select" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as 'admin' | 'manager' })}><option value="manager">应用管理员</option><option value="admin">管理员</option></select></Field>
          <Field label="权限" required>
            <div className="grid c2" style={{ gap: 6 }}>
              {SCOPES.map(([scope, label]) => (
                <label key={scope} className="row" style={{ fontSize: 13 }}>
                  <input type="checkbox" checked={form.scopes.includes(scope)} onChange={(event) => setForm({ ...form, scopes: event.target.checked ? [...form.scopes, scope] : form.scopes.filter((item) => item !== scope) })} />
                  {label}<span className="faint mono">{scope}</span>
                </label>
              ))}
            </div>
          </Field>
        </>}
      </Modal>
      <ConfirmModal open={!!revoking} danger title="吊销 Token" confirmText="吊销" body={<>吊销后使用「{revoking?.name}」的业务系统会立即失去访问权限。</>} onClose={() => setRevoking(null)}
        onConfirm={async () => { if (!revoking) return; try { await apiFetch(`/auth/api-clients/${revoking.id}`, { method: 'DELETE' }); toast('已吊销'); await load(); } catch (caught) { toast(errorMessage(caught), 'error'); } }} />
    </>
  );
}

const AUDIT_ACTION: Record<string, string> = {
  'application.created': '创建应用', 'application.draft_updated': '修改草稿', 'application.version_created': '生成版本', 'application.published': '发布',
  'application.unpublished': '下线', 'application.rolled_back': '回滚版本', 'application.archived': '归档应用', 'application.restored': '恢复应用',
  'application.deleted': '删除应用', 'application.duplicated': '复制应用', 'application.evaluated': '运行评测', 'application.share_created': '创建分享链接',
  'application.share_revoked': '停用分享链接', 'evaluation_set.created': '创建评测集', 'evaluation_set.ai_designed': 'AI 设计评测集', 'evaluation_set.run': '运行评测集',
  'evaluation_case.updated': '修改评测 Case', 'evaluation_case.returned': '日志回流为 Case', 'member.invited': '邀请成员', 'member.role_updated': '修改成员角色',
  'member.removed': '移除成员', 'api_client.created': '创建 API Token', 'api_client.revoked': '吊销 API Token', 'tool.created': '新增工具', 'tool.updated': '修改工具',
  'tool.deleted': '删除工具', 'tool.tested': '测试工具',
};
const RESOURCE_LABEL: Record<string, string> = { application: '应用', evaluation_set: '评测集', evaluation_case: '评测 Case', member: '成员', api_client: 'API Token', tool: '工具' };

function auditSummary(detail: Record<string, unknown>) {
  const parts = Object.entries(detail ?? {}).filter(([, value]) => value !== null && value !== '' && typeof value !== 'object').map(([key, value]) => `${key}: ${String(value)}`);
  return parts.join(' · ');
}

function AuditView() {
  const toast = useToast();
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({ limit: '200' });
      if (search.trim()) query.set('search', search.trim());
      if (action) query.set('action', action);
      apiFetch<AuditEvent[]>(`/audit-events?${query}`).then(setEvents).catch((caught) => toast(errorMessage(caught), 'error'));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [search, action, toast]);
  return (
    <div className="card pad">
      <div className="row wrap" style={{ gap: 12, marginBottom: 12 }}>
        <div className="search-box grow" style={{ maxWidth: 320 }}><Search size={15} /><input className="input sm" aria-label="搜索审计日志" placeholder="搜索动作、对象类型或 ID" value={search} onChange={(event) => setSearch(event.target.value)} /></div>
        <select className="select" style={{ width: 180 }} aria-label="按动作筛选" value={action} onChange={(event) => setAction(event.target.value)}>
          <option value="">全部动作</option>
          {Object.entries(AUDIT_ACTION).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <span className="faint">最近 200 条</span>
      </div>
      {!events ? <Loading /> : !events.length ? <Empty title="没有审计记录" desc="发布、评测、成员与 Token 变更等关键操作会记录在这里。" /> : (
        <table className="table">
          <thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>对象</th><th>详情</th></tr></thead>
          <tbody>{events.map((item) => (
            <tr key={item.id}>
              <td className="faint" style={{ whiteSpace: 'nowrap' }}>{formatTime(item.created_at)}</td>
              <td>{item.actor_name}</td>
              <td><Tag>{AUDIT_ACTION[item.action] ?? item.action}</Tag></td>
              <td className="muted">{RESOURCE_LABEL[item.resource_type] ?? item.resource_type}{item.resource_id ? <span className="faint" title={item.resource_id}> · {item.resource_id.slice(0, 8)}</span> : null}</td>
              <td className="faint ellipsis" style={{ maxWidth: 280 }} title={JSON.stringify(item.detail)}>{auditSummary(item.detail) || '—'}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </div>
  );
}

// 与后端各路由的 require_roles 保持一致；角色目前是内置的三种，暂不支持自定义
const PERMISSIONS: Array<[string, [boolean, boolean, boolean]]> = [
  ['在工作台使用已发布的应用、查看自己的对话', [true, true, true]],
  ['搭建、调试、发布、回滚应用，管理分享链接', [true, true, false]],
  ['管理知识库：导入、切块、检索测试', [true, true, false]],
  ['评测集、发布门禁与 LLM 评委', [true, true, false]],
  ['看板与可观测：运行 Trace、对话日志、用量与费用', [true, true, false]],
  ['集成：模型与工具配置', [true, false, false]],
  ['设置：成员、API Token、审计日志', [true, false, false]],
];
const ROLE_DESC: Record<Role, string> = {
  admin: '业务空间的全部权限，包括模型密钥、成员和审计。',
  manager: '负责应用交付：搭建应用、维护知识库、跑评测和看运营数据。',
  user: '业务人员：只能使用已发布的应用。',
};

function RolesView() {
  const roles: Role[] = ['admin', 'manager', 'user'];
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="grid c3">
        {roles.map((role) => <div key={role} className="card pad row" style={{ alignItems: 'flex-start' }}><ShieldCheck size={20} color="var(--primary)" /><div className="grow"><strong>{ROLE_LABEL[role]}</strong><div className="faint" style={{ marginTop: 4 }}>{ROLE_DESC[role]}</div></div></div>)}
      </div>
      <div className="card pad">
        <table className="table">
          <thead><tr><th>权限</th>{roles.map((role) => <th key={role} style={{ textAlign: 'center' }}>{ROLE_LABEL[role]}</th>)}</tr></thead>
          <tbody>{PERMISSIONS.map(([label, allowed]) => (
            <tr key={label}><td>{label}</td>{allowed.map((ok, index) => <td key={index} style={{ textAlign: 'center' }}>{ok ? <Check size={16} color="var(--green)" aria-label="允许" /> : <Minus size={16} className="faint" aria-label="不允许" />}</td>)}</tr>
          ))}</tbody>
        </table>
        <p className="faint" style={{ marginTop: 10 }}>角色在「成员」页签中分配。自定义角色、按部门设置应用可见范围需要接入企业 SSO 后提供。</p>
      </div>
    </div>
  );
}
