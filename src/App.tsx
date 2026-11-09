import type { PropsWithChildren } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from './auth';
import { canVisit, Shell } from './components/Shell';
import { Loading } from './components/ui';
import { AppEditorPage } from './pages/AppEditorPage';
import { AppsPage } from './pages/AppsPage';
import { ChatRunPage } from './pages/ChatRunPage';
import { EvaluationSetsPage } from './pages/EvaluationSetsPage';
import { ImportWizardPage } from './pages/ImportWizardPage';
import { KnowledgeDetailPage } from './pages/KnowledgeDetailPage';
import { KnowledgeListPage } from './pages/KnowledgeListPage';
import { LoginPage } from './pages/LoginPage';
import { ObservabilityPage } from './pages/ObservabilityPage';
import { InsightsPage } from './pages/InsightsPage';
import { SettingsPage } from './pages/SettingsPage';
import { SharePage } from './pages/SharePage';
import { ToolsPage } from './pages/ToolsPage';
import { WorkbenchPage } from './pages/WorkbenchPage';
import { AfterSalesPage } from './pages/commerce/AfterSalesPage';
import { BuyerPage } from './pages/commerce/BuyerPage';
import { InboundPage } from './pages/commerce/InboundPage';
import { InventoryPage } from './pages/commerce/InventoryPage';
import { OrdersPage } from './pages/commerce/OrdersPage';
import { OutboundPage } from './pages/commerce/OutboundPage';
import { OverviewPage } from './pages/commerce/OverviewPage';
import { ProductsPage } from './pages/commerce/ProductsPage';
import { ServiceDeskPage } from './pages/commerce/ServiceDeskPage';
import { WarehousesPage } from './pages/commerce/WarehousesPage';

function Protected({ children }: PropsWithChildren) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading text="正在验证登录状态" />;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (!canVisit(me.role, location.pathname)) return <Navigate to="/workbench" replace />;
  return <Shell>{children}</Shell>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/share/:token" element={<SharePage />} />
      <Route path="/commerce" element={<Protected><OverviewPage /></Protected>} />
      <Route path="/service" element={<Protected><ServiceDeskPage /></Protected>} />
      <Route path="/service/buyer" element={<Protected><BuyerPage /></Protected>} />
      <Route path="/orders" element={<Protected><OrdersPage /></Protected>} />
      <Route path="/products" element={<Protected><ProductsPage /></Protected>} />
      <Route path="/after-sales" element={<Protected><AfterSalesPage /></Protected>} />
      <Route path="/inventory" element={<Protected><InventoryPage /></Protected>} />
      <Route path="/inbound" element={<Protected><InboundPage /></Protected>} />
      <Route path="/outbound" element={<Protected><OutboundPage /></Protected>} />
      <Route path="/warehouses" element={<Protected><WarehousesPage /></Protected>} />
      <Route path="/workbench" element={<Protected><WorkbenchPage /></Protected>} />
      <Route path="/chat/:appId" element={<Protected><ChatRunPage /></Protected>} />
      <Route path="/apps" element={<Protected><AppsPage /></Protected>} />
      <Route path="/apps/:appId" element={<Protected><AppEditorPage /></Protected>} />
      <Route path="/knowledge" element={<Protected><KnowledgeListPage /></Protected>} />
      <Route path="/knowledge/:kbId/import" element={<Protected><ImportWizardPage /></Protected>} />
      <Route path="/knowledge/:kbId/*" element={<Protected><KnowledgeDetailPage /></Protected>} />
      <Route path="/insights" element={<Protected><InsightsPage /></Protected>} />
      <Route path="/observability" element={<Protected><ObservabilityPage /></Protected>} />
      <Route path="/evaluation-sets" element={<Protected><EvaluationSetsPage /></Protected>} />
      <Route path="/tools" element={<Protected><ToolsPage /></Protected>} />
      <Route path="/settings" element={<Protected><SettingsPage /></Protected>} />
      <Route path="*" element={<Navigate to="/commerce" replace />} />
    </Routes>
  );
}
