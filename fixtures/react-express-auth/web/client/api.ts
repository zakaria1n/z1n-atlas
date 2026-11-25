const JSON_HEADERS = { 'Content-Type': 'application/json' };

export const api = {
  post: (path: string, body: unknown) =>
    fetch(path, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    }),
};
