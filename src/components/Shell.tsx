import { Activity, BarChart3, Blocks, Bot, Boxes, ClipboardCheck, Database, Headset, LayoutDashboard, LayoutGrid, LogOut, Package, PackageCheck, PackagePlus, Plug, ReceiptText, RotateCcw, Settings, Warehouse, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { isManager, useAuth } from '../auth';
import type { Role } from '../types';

type NavItem = { to: string; label: string; icon: LucideIcon; roles: Role[] };

const STAFF: Role[] = ['admin', 'manager'];
const BUSINESS: Role[] = [...STAFF, 'cs_agent', 'warehouse'];
const SERVICE: Role[] = [...STAFF, 'cs_agent'];
const STOREHOUSE: Role[] = [...STAFF, 'warehouse'];

export const NAV: NavItem[] = [
  { to: '/commerce', label: '总览', icon: LayoutDashboard, roles: BUSINESS },
  { to: '/service', label: '客服', icon: Headset, roles: SERVICE },
  { to: '/orders', label: '订单', icon: ReceiptText, roles: SERVICE },
  { to: '/products', label: '商品', icon: Package, roles: BUSINESS },
  { to: '/after-sales', label: '售后', icon: RotateCcw, roles: BUSINESS },
  { to: '/inventory', label: '库存', icon: Boxes, roles: STOREHOUSE },
  { to: '/inbound', label: '入库', icon: PackagePlus, roles: STOREHOUSE },
  { to: '/outbound', label: '出库', icon: PackageCheck, roles: STOREHOUSE },
  { to: '/warehouses', label: '仓库', icon: Warehouse, roles: STOREHOUSE },
];

export const AI_NAV: NavItem[] = [
  { to: '/apps', label: '应用', icon: Blocks, roles: STAFF },
  { to: '/knowledge', label: '知识库', icon: Database, roles: STAFF },
  { to: '/workbench', label: '工作台', icon: LayoutGrid, roles: [...STAFF, 'user'] },
  { to: '/insights', label: '看板', icon: BarChart3, roles: STAFF },
  { to: '/observability', label: '可观测', icon: Activity, roles: STAFF },
  { to: '/evaluation-sets', label: '评测集', icon: ClipboardCheck, roles: STAFF },
  { to: '/tools', label: '集成', icon: Plug, roles: ['admin'] },
];

const ROLE_LABEL: Record<Role, string> = { admin: '管理员', manager: '应用管理员', user: '业务使用者', cs_agent: '客服', warehouse: '仓管' };

export function canVisit(role: Role, path: string) {
  if (path.startsWith('/chat/') || path.startsWith('/workbench')) return true;
  if (path.startsWith('/settings')) return role === 'admin';
  const item = [...NAV, ...AI_NAV].find((nav) => path.startsWith(nav.to));
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
  const aiItems = AI_NAV.filter((item) => item.roles.includes(role));
  const inAi = pathname.startsWith('/chat/') || AI_NAV.some((item) => pathname.startsWith(item.to));
  // 只在各模块的列表页显示；应用编排等全屏页面保持原有的顶部工具栏
  const showAiTabs = isManager(role) && AI_NAV.some((item) => pathname === item.to);

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
          <NavLink key={to} to={to} className={() => `nav-item ${pathname.startsWith(to) ? 'active' : ''}`}>
            <Icon size={20} aria-hidden="true" /><span>{label}</span>
          </NavLink>
        ))}
        {aiItems.length ? (
          <NavLink to={aiItems[0].to} className={() => `nav-item ${inAi ? 'active' : ''}`}>
            <Bot size={20} aria-hidden="true" /><span>{isManager(role) ? 'AI 配置' : aiItems[0].label}</span>
          </NavLink>
        ) : null}
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
      <main className="main">
        {showAiTabs ? (
          <div className="tabs ai-tabs" role="tablist" aria-label="AI 配置">
            {aiItems.map(({ to, label }) => <NavLink key={to} to={to} role="tab" aria-selected={pathname === to} className={`tab ${pathname === to ? 'active' : ''}`}>{label}</NavLink>)}
          </div>
        ) : null}
        {children}
      </main>
    </div>
  );
}
