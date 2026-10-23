/**
 * A booking as the Bookings list shows it: the shared contract's
 * `LinkBooking` (lib/booking/bookings.ts), exactly what the bookings API
 * returns (GET /api/booking/bookings?scope=upcoming|past|messages).
 */
export type { LinkBooking as TabBooking } from '@/lib/booking/bookings';
