// One small helper for every call to the backend.
// It returns the parsed JSON, or throws an Error with the message the backend sent.
export async function api(path, options) {
  const res = await fetch(path, options);
  let body = null;
  try {
    body = await res.json();
  } catch {
    // the answer was not JSON
  }
  if (!res.ok) {
    throw new Error((body && body.error) || `Request failed (${res.status})`);
  }
  return body;
}