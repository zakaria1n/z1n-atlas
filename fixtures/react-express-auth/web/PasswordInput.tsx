import React from 'react';

export function PasswordInput({ onChange }: { onChange: (value: string) => void }) {
  return (
    <input
      type="password"
      aria-label="Password"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
