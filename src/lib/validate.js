'use strict';

const crypto = require('node:crypto');
const { z } = require('zod');

const emailSchema = z
  .string({ required_error: 'Email is required', invalid_type_error: 'Email must be a string' })
  .trim()
  .min(3, 'Email is too short')
  .max(254, 'Email is too long')
  .email('Enter a valid email address')
  .transform((value) => value.toLowerCase());

const skuSchema = z
  .string({ required_error: 'SKU is required', invalid_type_error: 'SKU must be a string' })
  .trim()
  .min(1, 'SKU is required')
  .max(64, 'SKU is too long')
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'SKU contains invalid characters')
  .transform((value) => value.toUpperCase());

const requestSchema = z.object({ email: emailSchema, sku: skuSchema }).strict();

const eventIdSchema = z
  .string({ required_error: 'event_id is required' })
  .trim()
  .min(1, 'event_id is required')
  .max(128, 'event_id is too long')
  .regex(/^[A-Za-z0-9._:-]+$/, 'event_id contains invalid characters');

const webhookSchema = z
  .object({
    event_id: eventIdSchema,
    type: z.string().trim().max(50).optional(),
    sku: skuSchema,
    quantity: z.coerce.number().finite().int('quantity must be an integer').min(0).max(1_000_000_000),
    occurred_at: z.string().trim().max(50).optional(),
  })
  .passthrough();

function issueMessage(error) {
  const issue = error && error.issues && error.issues[0];
  return issue ? issue.message : 'Invalid request';
}

function safeEqual(a, b) {
  const left = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const right = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(left, right);
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

module.exports = {
  emailSchema,
  skuSchema,
  requestSchema,
  webhookSchema,
  issueMessage,
  safeEqual,
  escapeLike,
};
