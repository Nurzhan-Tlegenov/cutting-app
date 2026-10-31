import StopGate from './components/AppStop'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { Component, Suspense, useEffect } from 'react'
import { lazyPage, preloadPages } from './lib/lazyPage'
import NetStatus from './components/NetStatus'

class ErrorBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(e) { return { error: e } }
  render() {
    const e = this.state.error
    // страница не скачалась даже после повторов (слабый интернет) — понятное сообщение и кнопка, а не текст ошибки
    if (e && (e.chunkLoad || /dynamically imported module|Importing a module script failed|Loading chunk|error loading dynamically/i.test(String(e.message || e)))) return (
      <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, padding: 20, textAlign: 'center', fontSize: 14, color: '#444' }}>
        <div style={{ fontSize: 17, fontWeight: 600, color: '#222' }}>Не удалось загрузить страницу</div>
        <div style={{ maxWidth: 380, lineHeight: 1.45 }}>Связь слабая или пропала. Данные заказов не пострадали — нажмите «Повторить», когда связь появится.</div>
        <button type="button" onClick={() => window.location.reload()} style={{ padding: '10px 22px', borderRadius: 10, border: 'none', background: '#009BDE', color: '#fff', fontSize: 15, fontWeight: 600 }}>Повторить</button>
      </div>
    )
    if (e) return (
      <div style={{ padding: 20, color: 'red', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
        <b>Ошибка:</b>{String(this.state.error)}
        {this.state.error?.stack}
      </div>
    )
    return this.props.children
  }
}
import { AuthProvider, useAuth } from './context/AuthContext'
import './index.css'

import AuthPage from './pages/AuthPage'
import { CompleteProfilePage, NewPasswordPage } from './pages/CompleteProfilePage'
import OrdersPage from './pages/OrdersPage'
const OrderPage = lazyPage(() => import('./pages/OrderPage'))
const NewOrderPage = lazyPage(() => import('./pages/NewOrderPage'))
const ProfilePage = lazyPage(() => import('./pages/ProfilePage'))
const NestingPage = lazyPage(() => import('./pages/NestingPage'))
const EditOrderPage = lazyPage(() => import('./pages/EditOrderPage'))
const SharedModelPage = lazyPage(() => import('./pages/SharedModelPage'))
const SharedSimPage = lazyPage(() => import('./pages/SharedSimPage'))
const UsersPage = lazyPage(() => import('./pages/UsersPage'))
const ActivityPage = lazyPage(() => import('./pages/ActivityPage'))
import NewsPopup from './components/NewsPopup'
const AllOrdersPage = lazyPage(() => import('./pages/AllOrdersPage'))
const AllProductionsPage = lazyPage(() => import('./pages/AllProductionsPage'))
import KeyboardNext from './components/KeyboardNext'
import ProductionPage from './pages/ProductionPage'
const CncPage = lazyPage(() => import('./pages/CncPage'))
const LabelsPage = lazyPage(() => import('./pages/LabelsPage'))
const LabelSettingsPage = lazyPage(() => import('./pages/LabelsPage'), 'LabelSettingsPage')
const MessagesPage = lazyPage(() => import('./pages/MessagesPage'))
const NoticesPage = lazyPage(() => import('./pages/NoticesPage'))
const ScanPage = lazyPage(() => import('./pages/ScanPage'))
const JoinPage = lazyPage(() => import('./pages/JoinPage'))
const RefPage = lazyPage(() => import('./pages/RefPage'))
const InvitePage = lazyPage(() => import('./pages/InvitePage'))
const PostPage = lazyPage(() => import('./pages/PostPage'))
const HelpPage = lazyPage(() => import('./pages/HelpPage'))
const TasksPage = lazyPage(() => import('./pages/TasksPage'))
const StockPage = lazyPage(() => import('./pages/StockPage'))
import { startBackupTimer } from './lib/stockBackup'
const PostAccessPage = lazyPage(() => import('./pages/PostAccessPage'))
const LoadPage = lazyPage(() => import('./pages/LoadPage'))
import TourOverlay from './components/TourOverlay'
import { pendingInvite } from './lib/workplaces'
import { pendingRef } from './lib/refLinks'
import CncLoader from './components/CncLoader'
import UpdateWatcher from './components/UpdateWatcher'
import Watermark from './components/Watermark'
import { resolveGo } from './lib/noticeNav'

// Переход по уведомлению (/go?t=…&f=…): переключить кабинет и открыть нужную страницу с подсветкой строки
function GoPage() {
  const { setCabinet } = useAuth()
  const loc = useLocation()
  const navigate = useNavigate()
  useEffect(() => { const [to, state] = resolveGo(loc.search, setCabinet); navigate(to, { replace: true, state }) }, [loc.key])   // eslint-disable-line react-hooks/exhaustive-deps
  return <CncLoader full label="Открываем…" />
}

// Приложение открыто по старому адресу (значок на телефоне ставили до raskroypro.com) — просим перейти на новый
function OldDomain() {
  if (!/cutting-app-nine\.vercel\.app$/i.test(window.location.hostname)) return null
  const go = () => window.location.replace('https://raskroypro.com' + window.location.pathname + window.location.search)
  return (
    <div style={{ position: 'fixed', top: 'calc(6px + env(safe-area-inset-top))', left: 8, right: 8, zIndex: 1300, background: 'var(--amber-light)', border: '1px solid var(--amber)', borderRadius: 12, padding: '10px 12px', fontSize: 13, boxShadow: '0 4px 16px rgba(0,0,0,.15)' }}>
      <b>Приложение открыто по старому адресу.</b> Откройте raskroypro.com и войдите заново, затем удалите старый значок и добавьте новый на главный экран (меню браузера → «Добавить на главный экран»).
      <div style={{ textAlign: 'right', marginTop: 6 }}>
        <button type="button" onClick={go} style={{ padding: '6px 14px', borderRadius: 8, border: 'none', background: 'var(--blue)', color: 'white', fontSize: 13, fontWeight: 500 }}>Открыть raskroypro.com</button>
      </div>
    </div>
  )
}

// Нажали на push-уведомление, а приложение уже открыто — переходим в нём, без второй копии
function PushBridge() {
  const navigate = useNavigate()
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const on = e => {
      if (e.data?.type === 'open-url') { const u = new URL(e.data.url, window.location.origin); navigate(u.pathname + u.search) }
      if (e.data?.type === 'notices-refresh') window.dispatchEvent(new Event('notices-seen'))
    }
    navigator.serviceWorker.addEventListener('message', on)
    return () => navigator.serviceWorker.removeEventListener('message', on)
  }, [navigate])
  return null
}

// Куда вернуться после входа: открыли ссылку (например, на рабочий пост) без входа — после входа попадаем туда же
const AFTER_LOGIN = 'afterLogin'
const afterLogin = () => { try { const v = sessionStorage.getItem(AFTER_LOGIN); if (v) sessionStorage.removeItem(AFTER_LOGIN); return v && v.startsWith('/') ? v : null } catch { return null } }
function ProtectedRoute({ children }) {
  const { user, loading, recovery, needsProfile } = useAuth()
  const loc = useLocation()
  if (loading) return <CncLoader full label="Открываем приложение…" />
  if (!user) {
    try { sessionStorage.setItem(AFTER_LOGIN, loc.pathname + loc.search) } catch { /* без памяти */ }
    return <Navigate to="/auth" replace />
  }
  if (recovery) return <NewPasswordPage />           // ссылка из письма «сменить пароль»
  if (needsProfile) return <CompleteProfilePage />   // вход по почте / Google: имя, страна, город — до работы
  return children
}

function AppRoutes() {
  const { user, loading, cabinet } = useAuth()
  if (user) startBackupTimer()            // автокопия склада остатков в файл — на компьютерах, где её включили
  if (loading) return <CncLoader full label="Открываем приложение…" />
  const home = cabinet === 'production' ? '/production' : '/orders'   // с чего начинается кабинет
  return (
    <Suspense fallback={<CncLoader full label="Загружаем страницу…" />}>
    <Routes>
      {/* 3D-модель по ссылке для клиента — без входа */}
      <Route path="/view/:token" element={<SharedModelPage />} />
      <Route path="/v/:code" element={<SharedModelPage />} />
      {/* симуляция обработки листа по ссылке — без входа */}
      <Route path="/s/:code" element={<SharedSimPage />} />
      <Route path="/auth" element={user ? <Navigate to={pendingInvite() ? `/join/${pendingInvite()}` : pendingRef() ? `/r/${pendingRef()}` : (afterLogin() || home)} /> : <AuthPage />} />
      <Route path="/join/:code" element={<JoinPage />} />
      <Route path="/r/:code" element={<RefPage />} />
      <Route path="/invite" element={<ProtectedRoute><InvitePage /></ProtectedRoute>} />
      <Route path="/orders" element={<ProtectedRoute><OrdersPage /></ProtectedRoute>} />
      <Route path="/orders/new" element={<ProtectedRoute><NewOrderPage /></ProtectedRoute>} />
      <Route path="/orders/:id" element={<ProtectedRoute><OrderPage /></ProtectedRoute>} />
      <Route path="/orders/:id/nesting" element={<ProtectedRoute><NestingPage /></ProtectedRoute>} />
      <Route path="/orders/:id/edit" element={<ProtectedRoute><EditOrderPage /></ProtectedRoute>} />
      <Route path="/orders/:id/cnc" element={<ProtectedRoute><CncPage /></ProtectedRoute>} />
      <Route path="/orders/:id/labels" element={<ProtectedRoute><LabelsPage /></ProtectedRoute>} />
      <Route path="/label-settings" element={<ProtectedRoute><LabelSettingsPage /></ProtectedRoute>} />
      <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
      <Route path="/users" element={<ProtectedRoute><UsersPage /></ProtectedRoute>} />
      <Route path="/activity" element={<ProtectedRoute><ActivityPage /></ProtectedRoute>} />
      <Route path="/all-orders" element={<ProtectedRoute><AllOrdersPage /></ProtectedRoute>} />
      <Route path="/all-productions" element={<ProtectedRoute><AllProductionsPage /></ProtectedRoute>} />
      <Route path="/production" element={<ProtectedRoute><ProductionPage /></ProtectedRoute>} />
      <Route path="/notices" element={<ProtectedRoute><NoticesPage /></ProtectedRoute>} />
      <Route path="/go" element={<ProtectedRoute><GoPage /></ProtectedRoute>} />
      <Route path="/messages" element={<ProtectedRoute><MessagesPage /></ProtectedRoute>} />
      <Route path="/help" element={<ProtectedRoute><HelpPage /></ProtectedRoute>} />
      <Route path="/tasks" element={<ProtectedRoute><TasksPage /></ProtectedRoute>} />
      <Route path="/post-access" element={<ProtectedRoute><PostAccessPage /></ProtectedRoute>} />
      <Route path="/load" element={<ProtectedRoute><LoadPage /></ProtectedRoute>} />
      <Route path="/stock" element={<ProtectedRoute><StockPage /></ProtectedRoute>} />
      <Route path="/scan" element={<ProtectedRoute><ScanPage /></ProtectedRoute>} />
      {/* рабочий пост по ссылке — окно одного поста (настольный компьютер со сканером); видят только свои */}
      <Route path="/post/:id" element={<ProtectedRoute><PostPage /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to={user ? home : '/auth'} />} />
    </Routes>
    </Suspense>
  )
}

export default function App() {
  useEffect(() => { preloadPages() }, [])   // остальные страницы — тихо в фоне, после запуска
  return (
    <BrowserRouter>
      <AuthProvider>
        <ErrorBoundary>
          {/* остановка приложения мастер-аккаунтом: у остальных — заставка (AppStop.jsx) */}
          <StopGate>
            <AppRoutes />
            <PushBridge />
            <KeyboardNext />
            <Watermark />
            <TourOverlay />
            <NewsPopup />
          </StopGate>
          <UpdateWatcher />
          <NetStatus />
          <OldDomain />
        </ErrorBoundary>
      </AuthProvider>
    </BrowserRouter>
  )
}
