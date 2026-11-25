export async function loadSession(token: string) {
  if (!token) return null;
  return { token, user: { id: '1', name: 'Ada' } };
}
