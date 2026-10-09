import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Component } from 'react'

class ErrorBoundary extends Component {
  state = { error: null }
  static getDerivedStateFromError(e) { return { error: e } }
  render() {
    if (this.state.error) return (
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
import OrdersPage from './pages/OrdersPage'
import OrderPage from './pages/OrderPage'
import NewOrderPage from './pages/NewOrderPage'
import ProfilePage from './pages/ProfilePage'
import NestingPage from './pages/NestingPage'
import EditOrderPage from './pages/EditOrderPage'
import SharedModelPage from './pages/SharedModelPage'
import SharedSimPage from './pages/SharedSimPage'
import UsersPage from './pages/UsersPage'
import AllOrdersPage from './pages/AllOrdersPage'
import AllProductionsPage from './pages/AllProductionsPage'
import KeyboardNext from './components/KeyboardNext'
import ProductionPage from './pages/ProductionPage'
import CncPage from './pages/CncPage'
import LabelsPage from './pages/LabelsPage'
import MessagesPage from './pages/MessagesPage'
import ScanPage from './pages/ScanPage'
import CncLoader from './components/CncLoader'
import Watermark from './components/Watermark'

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <CncLoader full label="Открываем приложение…" />
  if (!user) return <Navigate to="/auth" replace />
  return children
}

function AppRoutes() {
  const { user, loading, cabinet } = useAuth()
  if (loading) return <CncLoader full label="Открываем приложение…" />
  const home = cabinet === 'production' ? '/production' : '/orders'   // с чего начинается кабинет
  return (
    <Routes>
      {/* 3D-модель по ссылке для клиента — без входа */}
      <Route path="/view/:token" element={<SharedModelPage />} />
      <Route path="/v/:code" element={<SharedModelPage />} />
      {/* симуляция обработки листа по ссылке — без входа */}
      <Route path="/s/:code" element={<SharedSimPage />} />
      <Route path="/auth" element={user ? <Navigate to={home} /> : <AuthPage />} />
      <Route path="/orders" element={<ProtectedRoute><OrdersPage /></ProtectedRoute>} />
      <Route path="/orders/new" element={<ProtectedRoute><NewOrderPage /></ProtectedRoute>} />
      <Route path="/orders/:id" element={<ProtectedRoute><OrderPage /></ProtectedRoute>} />
      <Route path="/orders/:id/nesting" element={<ProtectedRoute><NestingPage /></ProtectedRoute>} />
      <Route path="/orders/:id/edit" element={<ProtectedRoute><EditOrderPage /></ProtectedRoute>} />
      <Route path="/orders/:id/cnc" element={<ProtectedRoute><CncPage /></ProtectedRoute>} />
      <Route path="/orders/:id/labels" element={<ProtectedRoute><LabelsPage /></ProtectedRoute>} />
      <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
      <Route path="/users" element={<ProtectedRoute><UsersPage /></ProtectedRoute>} />
      <Route path="/all-orders" element={<ProtectedRoute><AllOrdersPage /></ProtectedRoute>} />
      <Route path="/all-productions" element={<ProtectedRoute><AllProductionsPage /></ProtectedRoute>} />
      <Route path="/production" element={<ProtectedRoute><ProductionPage /></ProtectedRoute>} />
      <Route path="/messages" element={<ProtectedRoute><MessagesPage /></ProtectedRoute>} />
      <Route path="/scan" element={<ProtectedRoute><ScanPage /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to={user ? home : '/auth'} />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ErrorBoundary>
          <AppRoutes />
          <KeyboardNext />
          <Watermark />
        </ErrorBoundary>
      </AuthProvider>
    </BrowserRouter>
  )
}
