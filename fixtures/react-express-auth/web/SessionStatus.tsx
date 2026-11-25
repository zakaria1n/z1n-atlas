import React from 'react';
import { request } from './client/request';

export function SessionStatus() {
  const handleRefresh = async () => {
    const response = await request('/api/auth/session');
    return response;
  };

  return <button onClick={handleRefresh}>Refresh session</button>;
}
