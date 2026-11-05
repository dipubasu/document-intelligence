const ACTIVE = ['queued', 'processing'];
const DASH = '\u2014';
const SEP = ' \u00b7 ';

const dash = (value) => (value === null || value === undefined || value === '' ? DASH : value);

function money(item) {
  if (item.total === null || item.total === undefined) return DASH;
  return `${item.total}${item.currency ? ` ${item.currency}` : ''}`;
}

// A finished document where the extraction found nothing
function hasNoData(item) {
  return (
    item.status === 'completed' &&
    !item.invoice_number &&
    !item.supplier_name &&
    (item.total === null || item.total === undefined)
  );
}

// A table of all documents. Every value is shown as React text, so React escapes it (no XSS).
export default function DocumentList({ items, total, selectedId, onSelect, onRetry }) {
  const counts = { completed: 0, failed: 0, active: 0 };
  for (const item of items) {
    if (item.status === 'completed') counts.completed += 1;
    else if (item.status === 'failed') counts.failed += 1;
    else if (ACTIVE.includes(item.status)) counts.active += 1;
  }

  return (
    <section className="card">
      <h2>Documents ({total})</h2>
      <p className="muted">
        Shown: {items.length}
        {SEP}completed {counts.completed}
        {SEP}in progress {counts.active}
        {SEP}failed {counts.failed}
      </p>

      {items.length === 0 ? (
        <p>No documents yet. Upload a file above.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>File</th>
              <th>Status</th>
              <th>Invoice no.</th>
              <th>Supplier</th>
              <th>Total</th>
              <th>Issues</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className={item.id === selectedId ? 'selected' : ''}>
                <td>{item.id}</td>
                <td>
                  {item.original_name}
                  {item.status === 'failed' && item.error_message && (
                    <div className="error small">{item.error_message}</div>
                  )}
                </td>
                <td>
                  <span className={`badge badge-${item.status}`}>{item.status}</span>
                  {item.needs_review === 1 && <span className="badge badge-review">needs review</span>}
                </td>
                <td>
                  {hasNoData(item) ? (
                    <span className="muted small">No invoice data</span>
                  ) : (
                    dash(item.invoice_number)
                  )}
                </td>
                <td>{dash(item.supplier_name)}</td>
                <td>{money(item)}</td>
                <td>
                  {item.error_count > 0 && <span className="error">{item.error_count} error(s) </span>}
                  {item.warning_count > 0 && <span className="warn">{item.warning_count} warning(s)</span>}
                  {!item.error_count && !item.warning_count && DASH}
                </td>
                <td>
                  <button type="button" className="secondary" onClick={() => onSelect(item.id)}>
                    View
                  </button>{' '}
                  {item.status === 'failed' && (
                    <button type="button" onClick={() => onRetry(item.id)}>
                      Retry
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}