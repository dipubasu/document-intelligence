import { useRef, useState } from 'react';
import { api } from '../api.js';
import '../search.css';

const MIN_LENGTH = 2;
const MAX_LENGTH = 100;

function fieldsText(fields) {
  return Array.isArray(fields) ? fields.join(', ') : '';
}

function moneyText(item) {
  if (item.total === null || item.total === undefined) return '-';
  return `${item.total} ${item.currency || ''}`.trim();
}

function valuesText(item) {
  return [
    `Invoice: ${item.invoice_number || '-'}`,
    `Supplier: ${item.supplier_name || '-'}`,
    `Customer: ${item.customer_name || '-'}`,
    `Total: ${moneyText(item)}`,
  ].join(' \u00b7 ');
}

function pageLabel(page) {
  const sheet = page.sheet_name ? ` \u00b7 sheet "${page.sheet_name}"` : '';
  return `page ${page.page_number}${sheet}`;
}

export default function SearchPanel({ onSelect }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  // Only the newest search may update the screen.
  const lastRequest = useRef(0);

  async function handleSubmit(event) {
    event.preventDefault();
    const q = query.trim();
    if (q.length < MIN_LENGTH || q.length > MAX_LENGTH) {
      setMessage(`Type between ${MIN_LENGTH} and ${MAX_LENGTH} characters.`);
      return;
    }
    const requestId = lastRequest.current + 1;
    lastRequest.current = requestId;
    setBusy(true);
    setMessage('');
    try {
      const data = await api(
        `/api/search?q=${encodeURIComponent(q)}&mode=keyword&limit=20`
      );
      if (requestId !== lastRequest.current) return;
      setResult(data);
    } catch (err) {
      if (requestId !== lastRequest.current) return;
      setResult(null);
      setMessage(err.message);
    } finally {
      if (requestId === lastRequest.current) setBusy(false);
    }
  }

  function handleClear() {
    lastRequest.current += 1;
    setQuery('');
    setResult(null);
    setMessage('');
    setBusy(false);
  }

  const items = result ? result.items : [];

  return (
    <section className="search-panel">
      <h2>Search documents</h2>
      <form className="search-form" onSubmit={handleSubmit}>
        <input
          type="text"
          value={query}
          maxLength={MAX_LENGTH}
          placeholder="Invoice number, supplier, customer or any text"
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Searching...' : 'Search'}
        </button>
        <button type="button" onClick={handleClear}>
          Clear
        </button>
      </form>
      <p className="search-hint">Keyword search. Semantic search is not available yet.</p>

      {message && <p className="search-error">{message}</p>}

      {result && (
        <div>
          <p className="search-summary">
            {result.total === 0
              ? `No document matched "${result.query}".`
              : `${result.total} document(s) matched "${result.query}".`}
            {result.total > items.length && ` Showing the first ${items.length}.`}
          </p>
          <ul className="search-results">
            {items.map((item) => (
              <li key={item.document_id} className="search-item">
                <div className="search-item-head">
                  <strong>
                    #{item.document_id} {item.original_name}
                  </strong>
                  <span className="search-status">{item.status}</span>
                  {item.needs_review ? (
                    <span className="search-review">needs review</span>
                  ) : null}
                  <button type="button" onClick={() => onSelect(item.document_id)}>
                    View
                  </button>
                </div>
                <div className="search-values">{valuesText(item)}</div>
                {fieldsText(item.matched_fields) && (
                  <div className="search-matched">
                    Matched in: {fieldsText(item.matched_fields)}
                  </div>
                )}
                {Array.isArray(item.pages) &&
                  item.pages.map((page) => (
                    <div
                      key={`${page.page_number}-${page.sheet_name || ''}`}
                      className="search-snippet"
                    >
                      <span className="search-page">{pageLabel(page)}:</span> {page.snippet}
                    </div>
                  ))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}