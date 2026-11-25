import express from 'express';
import { pay } from './payments';

export const app = express();
// A route with a parameter never equals a concrete address, so it is not matched.
app.post('/orders/:orderId/pay', pay);
