import { useRef, useState } from 'react';
import { api } from '../api.js';
import '../search.css';

const MIN_LENGTH = 2;
const MAX_LENGTH = 100;

const HINTS = {
  keyword: 'Keyword search: finds documents that contain your words.',
  semantic:
    'Semantic search: ranks invoices by meaning (Gemini embeddings). Every invoice gets a score and there is no cutoff, so a low score can be unrelated. Invoice text is sent to Gemini.',
};

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

function scoreText(item) {
  return typeof item.score === 'number' ? item.score.toFixed(3) : '-';
}

export default function SearchPanel({ onSelect }) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('keyword');
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
        `/api/search?q=${encodeURIComponent(q)}&mode=${mode}&limit=20`
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

  function handleModeChange(next) {
    if (next === mode) return;
    // Drop the old result so it is never shown under the wrong mode.
    lastRequest.current += 1;
    setMode(next);
    setResult(null);
    setMessage('');
    setBusy(false);
  }

  function handleClear() {
    lastRequest.current += 1;
    setQuery('');
    setResult(null);
    setMessage('');
    setBusy(false);
  }

  const items = result ? result.items : [];
  const isSemantic = result ? result.mode === 'semantic' : false;

  function summaryText() {
    if (result.total === 0) {
      return isSemantic
        ? 'No invoices to compare yet.'
        : `No document matched "${result.query}".`;
    }
    return isSemantic
      ? `${result.total} invoice(s) ranked for "${result.query}". Higher score means closer in meaning.`
      : `${result.total} document(s) matched "${result.query}".`;
  }

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
      <div className="search-mode">
        <label>
          <input
            type="radio"
            name="search-mode"
            value="keyword"
            checked={mode === 'keyword'}
            onChange={() => handleModeChange('keyword')}
          />{' '}
          Keyword
        </label>
        <label>
          <input
            type="radio"
            name="search-mode"
            value="semantic"
            checked={mode === 'semantic'}
            onChange={() => handleModeChange('semantic')}
          />{' '}
          Semantic
        </label>
      </div>
      <p className="search-hint">{HINTS[mode]}</p>

      {message && <p className="search-error">{message}</p>}

      {result && (
        <div>
          <p className="search-summary">
            {summaryText()}
            {result.total > items.length && ` Showing the first ${items.length}.`}
          </p>
          {result.not_indexed > 0 && (
            <p className="search-note">
              {result.not_indexed} invoice(s) are not indexed yet and are missing from this
              ranking. Search again to index them.
            </p>
          )}
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
                  {isSemantic && (
                    <span className="search-score">score {scoreText(item)}</span>
                  )}
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