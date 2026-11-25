import axios from 'axios';

export const http = axios.create({ baseURL: '/api' });

export const fetchSession = (token: string) =>
  http.get('/session', { params: { token } });

export const listUsers = () => http.get('/users');
