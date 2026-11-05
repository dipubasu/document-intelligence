import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import UploadBox from './components/UploadBox.jsx';
import DocumentList from './components/DocumentList.jsx';
import ResultPanel from './components/ResultPanel.jsx';

const POLL_MS = 2000;

export default function App() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState(null);

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

  // The panel reloads when the selected document changes its status or issue counts.
  const selected = items.find((i) => i.id === selectedId);
  const version = selected
    ? `${selected.status}|${selected.needs_review}|${selected.error_count}|${selected.warning_count}`
    : '';

  return (
    <main className="page">
      <h1>Document Intelligence</h1>
      {error && <p className="error">{error}</p>}
      <UploadBox onUploaded={load} />
      {selectedId !== null && (
        <ResultPanel
          key={selectedId}
          documentId={selectedId}
          version={version}
          onClose={() => setSelectedId(null)}
        />
      )}
      <DocumentList
        items={items}
        total={total}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onRetry={retry}
      />
    </main>
  );
}