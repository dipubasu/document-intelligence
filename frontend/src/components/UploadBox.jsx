import { useRef, useState } from 'react';
import { api } from '../api.js';

// Choose several files and send them in one request. The backend answers at once
// (processing runs in the background), then the parent reloads the list.
export default function UploadBox({ onUploaded }) {
  const inputRef = useRef(null);
  const [chosen, setChosen] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function upload(event) {
    event.preventDefault();
    const files = inputRef.current.files;
    const n = files.length;
    if (n === 0) {
      setError('Choose at least one file first.');
      return;
    }

    const form = new FormData();
    for (const file of files) form.append('files', file);

    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api('/api/documents', { method: 'POST', body: form });
      setMessage(`${n} file(s) sent. Processing continues in the background.`);
      inputRef.current.value = '';
      setChosen(0);
      onUploaded();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <h2>Upload documents</h2>
      <form onSubmit={upload} className="row">
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.csv,.xlsx,.xls,.jpg,.jpeg,.png,.tif,.tiff"
          onChange={(e) => setChosen(e.target.files.length)}
        />
        <button type="submit" disabled={busy || chosen === 0}>
          {busy ? 'Uploading...' : `Upload ${chosen > 0 ? chosen : ''} file(s)`}
        </button>
      </form>
      {message && <p className="ok">{message}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}