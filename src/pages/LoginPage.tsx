import { ArrowRight } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { useAuth } from '../auth';
import { Field, Notice, Spinner } from '../components/ui';

export function LoginPage() {
  const { me, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('admin@fde.local');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const from = (location.state as { from?: string } | null)?.from ?? '/workbench';

  if (me) return <Navigate to={from} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <form className="card login-card" onSubmit={(event) => void submit(event)}>
        <div className="row" style={{ marginBottom: 20 }}>
          <span className="nav-logo" style={{ margin: 0 }}>序</span>
          <div><h1 style={{ fontSize: 20 }}>知序 KnowOrder</h1><p className="faint">让企业知识井然有序 · 知识库 · Agent · 评测</p></div>
        </div>
        {error ? <div style={{ marginBottom: 14 }}><Notice tone="error" title="登录失败">{error}</Notice></div> : null}
        <Field label="邮箱"><input className="input" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></Field>
        <Field label="密码"><input className="input" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required minLength={8} autoFocus /></Field>
        <button className="btn primary" style={{ width: '100%', height: 40 }} disabled={busy}>{busy ? <Spinner /> : <ArrowRight size={16} />}{busy ? '正在登录' : '登录'}</button>
        <p className="faint" style={{ marginTop: 14 }}>开发环境初始账号 admin@fde.local，密码由 APP_BOOTSTRAP_ADMIN_PASSWORD 配置。</p>
      </form>
    </div>
  );
}
