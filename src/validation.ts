import type { ErrorResponse } from './types.js';

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: ErrorResponse['code']) {
    super(message);
  }
}

// 条件に失敗したときは例外になるため、呼び出し元でも成功時の型に絞り込める。
export function requireValue(condition: unknown, message = '入力内容を確認してください。'): asserts condition {
  if (!condition) throw new ApiError(400, message);
}

export function objectWith(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
  requireValue(Object.keys(value).every(key => keys.includes(key)));
}

export const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
export const idPattern = /^[A-Za-z0-9_-]{1,64}$/;
export const textFits = (text: unknown, limit: number): text is string =>
  typeof text === 'string' && text.trim().length > 0 && [...text].length <= limit;
