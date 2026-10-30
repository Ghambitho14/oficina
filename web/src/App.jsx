import { useEffect, useState } from 'react';
import { api } from './api.js';
import { brand } from './brand.js';
import Office from './Office.jsx';

function Login({ onLogin }) {
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/login', { method: 'POST', body: { user, password } });
      onLogin();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit} className="card">
        <h1>{brand.app}</h1>
        <p className="muted">Agentes vigilando tu VPS</p>
        <label>
          Usuario
          <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Contraseña
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <p className="error">{error}</p>}
        <button disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </main>
  );
}

export default function App() {
  const [me, setMe] = useState(undefined);

  const load = () => api('/me').then(setMe).catch(() => setMe(null));
  useEffect(() => {
    load();
  }, []);

  if (me === undefined) return null;
  if (!me) return <Login onLogin={load} />;
  return <Office me={me} onLogout={() => api('/logout', { method: 'POST' }).then(() => setMe(null))} />;
}
