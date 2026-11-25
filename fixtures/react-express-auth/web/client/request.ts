export async function request(path: string, options?: RequestInit) {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error('Request failed');
  return response.json();
}
