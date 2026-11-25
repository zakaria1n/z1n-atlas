import React, { useState } from 'react';
import { fetchSession } from '../lib/api';

export function LoginForm() {
  const [token, setToken] = useState('');

  const handleLogin = async () => {
    const session = await fetchSession(token);
    return session;
  };

  return (
    <form onSubmit={handleLogin}>
      <input
        aria-label="Token"
        onChange={(event) => setToken(event.target.value)}
      />
      <button type="submit">Sign in</button>
    </form>
  );
}
