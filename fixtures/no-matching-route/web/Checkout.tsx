import React, { useState } from 'react';

export function Checkout() {
  const [orderId, setOrderId] = useState('');

  const handlePay = async () => {
    await fetch(`/api/orders/${orderId}/pay`, { method: 'POST' });
  };
  const handleRetry = async () => {
    await fetch('/api/missing', { method: 'POST' });
  };

  return (
    <section>
      <input
        aria-label="Order"
        onChange={(event) => setOrderId(event.target.value)}
      />
      <button type="button" onClick={handlePay}>
        Pay
      </button>
      <button type="button" onClick={handleRetry}>
        Retry
      </button>
    </section>
  );
}
