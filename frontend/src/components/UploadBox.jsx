import { useRef, useState } from 'react';
import { api } from '../api.js';

// Choose several files and send them in one request. The backend answers at once
// (processing runs in the background). The answer lists which files were accepted
// and which were rejected (with a reason), and we show both.
export default function UploadBox({ onUploaded }) {
  const inputRef = useRef(null);
  const [chosen, setChosen] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [rejected, setRejected] = useState([]);
  const [error, setError] = useState('');

  async function upload(event) {
    event.preventDefault();
    const files = inputRef.current.files;
    if (files.length === 0) {
      setError('Choose at least one file first.');
      return;
    }

    const form = new FormData();
    for (const file of files) form.append('files', file);

    setBusy(true);
    setError('');
    setMessage('');
    setRejected([]);
    try {
      const data = await api('/api/documents', { method: 'POST', body: form });
      const acceptedCount = data && Array.isArray(data.accepted) ? data.accepted.length : files.length;
      const rejectedList = data && Array.isArray(data.rejected) ? data.rejected : [];

      setMessage(`${acceptedCount} file(s) accepted. Processing continues in the background.`);
      setRejected(rejectedList);
      inputRef.current.value = '';
      setChosen(0);
      onUploaded();
    } catch (err) {
      // also covers the case where every file was rejected (HTTP 400 with an error text)
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
      {rejected.length > 0 && (
        <div className="error">
          <p>{rejected.length} file(s) rejected:</p>
          <ul>
            {rejected.map((r, i) => (
              <li key={i}>
                {r.name}: {r.error}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}