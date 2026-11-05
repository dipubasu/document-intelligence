import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import UploadBox from './components/UploadBox.jsx';
import DocumentList from './components/DocumentList.jsx';

const POLL_MS = 2000;

export default function App() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await api('/api/documents?limit=50');
      setItems(data.items);
      setTotal(data.total);
      setError('');
    } catch (err) {
      setError(`Cannot load documents: ${err.message}`);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll only while something is still queued or processing, then stop.
  const active = items.some((i) => i.status === 'queued' || i.status === 'processing');
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  async function retry(id) {
    try {
      await api(`/api/documents/${id}/reprocess`, { method: 'POST' });
      await load();
    } catch (err) {
      setError(`Retry failed: ${err.message}`);
    }
  }

  return (
    <main className="page">
      <h1>Document Intelligence</h1>
      {error && <p className="error">{error}</p>}
      <UploadBox onUploaded={load} />
      <DocumentList items={items} total={total} onRetry={retry} />
    </main>
  );
}