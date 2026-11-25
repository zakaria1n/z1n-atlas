// The one API client the booking page uses. Its first argument is forwarded
// to fetch, and the HTTP method travels inside the destructured options.
export async function apiRequest(path, { method = "GET", body } = {}) {
  const headers = {};
  if (method !== "GET") headers["Content-Type"] = "application/json";
  const response = await fetch(path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error("The request failed.");
  return response.json();
}
