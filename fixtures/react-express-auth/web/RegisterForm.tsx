import React, { useState } from 'react';
import { api } from './client/api';
import { PasswordInput } from './PasswordInput';
import { SubmitButton } from './SubmitButton';

export function RegisterForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleRegister = async () => {
    await api.post('/api/auth/register', { email, password });
  };
  const handleReset = async () => {
    await api.post('/api/auth/register', { email, password: '' });
  };

  return (
    <form onSubmit={handleRegister} onReset={handleReset}>
      <PasswordInput onChange={setPassword} />
      <SubmitButton />
    </form>
  );
}
