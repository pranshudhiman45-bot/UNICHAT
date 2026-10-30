import { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './hooks/useAuth';
import './index.css';

const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
const Workspaces = lazy(() => import('./pages/Workspaces'));
const Chat = lazy(() => import('./pages/Chat'));
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'));
const Admin = lazy(() => import('./pages/Admin'));
const RecoveryApproval = lazy(() => import('./pages/RecoveryApproval'));

function AuthGate({ requireAuth }: { requireAuth: boolean }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[var(--background)] text-sm text-[var(--text-secondary)]" role="status">
        Loading Unichat...
      </div>
    );
  }

  if (requireAuth) {
    if (user) return <Outlet />;
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    return <Navigate to={`/login?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }

  return user ? <Navigate to={user.role === 'SUPER_ADMIN' ? '/admin' : '/workspaces'} replace /> : <Outlet />;
}

function AdminGate() {
  const { user } = useAuth();
  return user?.role === 'SUPER_ADMIN' ? <Outlet /> : <Navigate to="/workspaces" replace />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/recovery/approve" element={<RecoveryApproval />} />
      <Route element={<AuthGate requireAuth={false} />}>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
      </Route>

      <Route element={<AuthGate requireAuth />}>
        <Route path="/workspaces" element={<Workspaces />} />
        <Route path="/chat/:workspaceId" element={<Chat />} />
        <Route element={<AdminGate />}><Route path="/admin" element={<Admin />} /></Route>
        <Route path="/" element={<Navigate to="/workspaces" replace />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function App() {
  return (
    <AuthProvider>
      <Router>
        <Suspense fallback={<div className="flex min-h-dvh items-center justify-center bg-[var(--background)] text-sm text-[var(--text-secondary)]" role="status">Loading Unichat…</div>}><AppRoutes /></Suspense>
      </Router>
    </AuthProvider>
  );
}

export default App;
