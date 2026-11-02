import { Activity, BarChart3, Blocks, ClipboardCheck, Database, Eye, EyeOff, LayoutGrid, Settings, Wrench } from 'lucide-react';
import type { PropsWithChildren } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAnnotate } from './ui';

const NAV = [
  { to: '/workbench', label: '工作台', icon: LayoutGrid },
  { to: '/apps', label: '应用', icon: Blocks },
  { to: '/knowledge', label: '知识库', icon: Database },
  { to: '/tools', label: '工具', icon: Wrench },
  { to: '/insights', label: '看板', icon: BarChart3 },
  { to: '/observability', label: '可观测', icon: Activity },
  { to: '/evaluation-sets', label: '评测', icon: ClipboardCheck },
];

export function Shell({ children, bare }: PropsWithChildren<{ bare?: boolean }>) {
  const { on, toggle } = useAnnotate();
  const { pathname } = useLocation();
  return (
    <div className="shell">
      <nav className="nav" aria-label="主导航">
        <div className="nav-logo" title="知序 AI 应用中台" style={{ marginBottom: 4 }}>序</div>
        <span className="tag orange" style={{ height: 'auto', fontSize: 10, lineHeight: 1.3, padding: '2px 5px', marginBottom: 12, textAlign: 'center', whiteSpace: 'normal' }} title="所有业务数据、报告内容、统计数字均为演示用的虚构数据">原型<br />示例数据</span>
        {NAV.map(({ to, label, icon: I }) => (
          <NavLink key={to} to={to} className={() => `nav-item ${pathname.startsWith(to) ? 'active' : ''}`}>
            <I size={20} aria-hidden="true" /><span>{label}</span>
          </NavLink>
        ))}
        <div className="nav-spacer" />
        <button className={`nav-item ${on ? 'active' : ''}`} onClick={toggle} title="评审用：显示每个功能的后端就绪度">
          {on ? <Eye size={18} /> : <EyeOff size={18} />}<span>开发标注</span>
        </button>
        <NavLink to="/settings" className={() => `nav-item ${pathname.startsWith('/settings') ? 'active' : ''}`}><Settings size={18} /><span>设置</span></NavLink>
        <div className="nav-avatar" title="周敏 · 管理员">周</div>
      </nav>
      <main className={`main ${bare ? 'bare' : ''}`}>{children}</main>
    </div>
  );
}
