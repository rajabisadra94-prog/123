import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from './store/authStore'
import { IS_MARKET_ONLY, HOME_PATH } from './lib/appMode'
import LoginPage from './pages/LoginPage'
import AppLayout from './components/layout/AppLayout'
import DashboardPage from './pages/DashboardPage'
import ProjectsPage from './pages/ProjectsPage'
import CrmPage from './pages/CrmPage'
import MarketPage from './pages/market/MarketPage'
import VendorsPage from './pages/VendorsPage'
import ProjectDetailPage from './pages/ProjectDetailPage'
import TechnicalReviewPage from './pages/TechnicalReviewPage'
import PricingPage from './pages/PricingPage'
import InvoicingPage from './pages/InvoicingPage'
import OrdersPage from './pages/OrdersPage'
import ShippingPage from './pages/ShippingPage'
import AccountingPage from './pages/AccountingPage'
import LedgerPage from './pages/LedgerPage'
import LedgerPartyPage from './pages/LedgerPartyPage'
import { ManualEntryPage } from './pages/LedgerPage'
import ArchivePage from './pages/ArchivePage'
import SettingsPage from './pages/SettingsPage'
import AuditLogPage from './pages/AuditLogPage'
import TasksPage from './pages/TasksPage'
import NotesPage from './pages/NotesPage'
import ChatPage from './pages/ChatPage'
import FeedbackPage from './pages/FeedbackPage'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  if (!isAuthenticated) return <Navigate to="/login" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to={HOME_PATH} replace />} />
          <Route path="market" element={<MarketPage />} />
          {/* در حالت «فقط بازار» بقیهٔ مسیرها اصلاً ثبت نمی‌شوند تا کدشان هم
              بارگذاری نشود و هر آدرسی به صفحهٔ بازار برگردد. */}
          {!IS_MARKET_ONLY && <>
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="crm" element={<CrmPage />} />
          <Route path="vendors" element={<VendorsPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:id" element={<ProjectDetailPage />} />
          <Route path="technical-review" element={<TechnicalReviewPage />} />
          <Route path="pricing" element={<PricingPage />} />
          <Route path="invoicing" element={<InvoicingPage />} />
          <Route path="orders" element={<OrdersPage />} />
          <Route path="shipping" element={<ShippingPage />} />
          <Route path="accounting" element={<AccountingPage />} />
          <Route path="ledger" element={<LedgerPage />} />
          <Route path="ledger/party/:id" element={<LedgerPartyPage />} />
          <Route path="ledger/entry/new" element={<ManualEntryPage />} />
          <Route path="archive" element={<ArchivePage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="audit-log" element={<AuditLogPage />} />
          <Route path="tasks" element={<TasksPage />} />
          <Route path="notes" element={<NotesPage />} />
          <Route path="chat" element={<ChatPage />} />
          <Route path="feedback" element={<FeedbackPage />} />
          </>}
          <Route path="*" element={<Navigate to={HOME_PATH} replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
