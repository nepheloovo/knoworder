import { Activity, BarChart3, Blocks, ClipboardCheck, Database, LayoutGrid, LogOut, Plug, Settings, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { isManager, useAuth } from '../auth';
import type { Role } from '../types';

type NavItem = { to: string; label: string; icon: LucideIcon; roles: Role[] };

const ALL: Role[] = ['admin', 'manager', 'user'];
const STAFF: Role[] = ['admin', 'manager'];

export const NAV: NavItem[] = [
  { to: '/workbench', label: '工作台', icon: LayoutGrid, roles: ALL },
  { to: '/apps', label: '应用', icon: Blocks, roles: STAFF },
  { to: '/knowledge', label: '知识库', icon: Database, roles: STAFF },
  { to: '/insights', label: '看板', icon: BarChart3, roles: STAFF },
  { to: '/observability', label: '可观测', icon: Activity, roles: STAFF },
  { to: '/evaluation-sets', label: '评测集', icon: ClipboardCheck, roles: STAFF },
  { to: '/tools', label: '集成', icon: Plug, roles: ['admin'] },
];

const ROLE_LABEL: Record<Role, string> = { admin: '管理员', manager: '应用管理员', user: '业务使用者' };

export function canVisit(role: Role, path: string) {
  if (path.startsWith('/chat/') || path.startsWith('/workbench')) return true;
  if (path.startsWith('/settings')) return role === 'admin';
  const item = NAV.find((nav) => path.startsWith(nav.to));
  return item ? item.roles.includes(role) : isManager(role);
}

export function Shell({ children }: PropsWithChildren) {
  const { me, logout } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const role = me?.role ?? 'user';
  const name = me?.user?.display_name ?? '访客';

  useEffect(() => setMenu(false), [pathname]);
  useEffect(() => {
    if (!menu) return undefined;
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenu(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menu]);

  return (
    <div className="shell">
      <nav className="nav" aria-label="主导航">
        <div className="nav-logo" title="知序 KnowOrder · AI 应用中台">序</div>
        {NAV.filter((item) => item.roles.includes(role)).map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={() => `nav-item ${pathname.startsWith(to) || (to === '/workbench' && pathname.startsWith('/chat/')) ? 'active' : ''}`}>
            <Icon size={20} aria-hidden="true" /><span>{label}</span>
          </NavLink>
        ))}
        <div className="nav-spacer" />
        {role === 'admin' ? <NavLink to="/settings" className={() => `nav-item ${pathname.startsWith('/settings') ? 'active' : ''}`}><Settings size={18} /><span>设置</span></NavLink> : null}
        <div className="nav-user" ref={menuRef}>
          <button className="nav-avatar" style={{ border: 0, cursor: 'pointer' }} aria-label="账号菜单" aria-expanded={menu} onClick={() => setMenu(!menu)}>{name.slice(0, 1)}</button>
          {menu ? (
            <div className="card nav-user-menu" role="menu">
              <strong>{name}</strong>
              <div className="faint">{me?.user?.email}</div>
              <div style={{ margin: '8px 0' }}><span className="tag blue">{ROLE_LABEL[role]}</span></div>
              <button className="btn sm" style={{ width: '100%' }} role="menuitem" onClick={async () => { await logout(); navigate('/login'); }}><LogOut size={14} />退出登录</button>
            </div>
          ) : null}
        </div>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}
