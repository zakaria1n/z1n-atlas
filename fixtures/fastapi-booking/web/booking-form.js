import { apiRequest } from "./api-client.js";

export const bookingsBase = "/api";

export function submitBooking(booking) {
  return apiRequest(`${bookingsBase}/bookings`, {
    method: "POST",
    body: booking,
  });
}

export function loadBooking(bookingId) {
  return apiRequest(`/api/bookings/${encodeURIComponent(bookingId)}`);
}

export function loadArchive() {
  return apiRequest("/api/archive");
}
