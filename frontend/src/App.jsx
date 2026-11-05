import { useEffect, useState } from 'react';
import { api } from './api.js';

export default function App() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/api/health')
      .then(setHealth)
      .catch((err) => setError(err.message));
  }, []);

  return (
    <main className="page">
      <h1>Document Intelligence</h1>
      <section className="card">
        <h2>Backend status</h2>
        {error && <p className="error">Cannot reach the backend: {error}</p>}
        {!error && !health && <p>Checking...</p>}
        {health && (
          <p>
            Backend: <strong>{health.status}</strong> (SQLite {health.sqlite}, {health.tables} tables)
          </p>
        )}
      </section>
    </main>
  );
}