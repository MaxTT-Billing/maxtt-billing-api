// onboarding.validation.js
import { z } from 'zod';

export const applicationSchema = z.object({
  legal_name: z.string().min(2),
  trade_name: z.string().optional(),
  contact_person: z.string().min(2),
  email: z.string().email(),
  phone: z.string().min(7).max(15),
  gstin: z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i, 'Invalid GSTIN'),
  pan: z.string().regex(/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/i, 'Invalid PAN'),
  address_line1: z.string().min(3),
  address_line2: z.string().optional(),
  city: z.string().min(2),
  state: z.string().min(2),
  pincode: z.string().regex(/^\d{6}$/, 'Invalid pincode')
});
