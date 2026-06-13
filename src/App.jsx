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

function ProtectedRoute({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: 'var(--text-hint)' }}>Загрузка...</div>
  if (!user) return <Navigate to="/auth" replace />
  return children
}

function AppRoutes() {
  const { user, loading } = useAuth()
  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh' }}>...</div>
  return (
    <Routes>
      <Route path="/auth" element={user ? <Navigate to="/orders" /> : <AuthPage />} />
      <Route path="/orders" element={<ProtectedRoute><OrdersPage /></ProtectedRoute>} />
      <Route path="/orders/new" element={<ProtectedRoute><NewOrderPage /></ProtectedRoute>} />
      <Route path="/orders/:id" element={<ProtectedRoute><OrderPage /></ProtectedRoute>} />
      <Route path="/orders/:id/nesting" element={<ProtectedRoute><NestingPage /></ProtectedRoute>} />
      <Route path="/orders/:id/edit" element={<ProtectedRoute><EditOrderPage /></ProtectedRoute>} />
      <Route path="/profile" element={<ProtectedRoute><ProfilePage /></ProtectedRoute>} />
      <Route path="*" element={<Navigate to={user ? '/orders' : '/auth'} />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ErrorBoundary>
          <AppRoutes />
        </ErrorBoundary>
      </AuthProvider>
    </BrowserRouter>
  )
}
