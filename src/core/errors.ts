export type ErrorDetails = Record<string, unknown> | unknown[] | undefined;

/**
 * Every error the API deliberately produces is an AppError. Anything else that
 * reaches the error middleware is treated as an unexpected 500 and logged with
 * a stack trace.
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details: ErrorDetails;
  public readonly expose: boolean;

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR', details?: ErrorDetails) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expose = statusCode < 500;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const BadRequest = (message = 'Bad request', details?: ErrorDetails) =>
  new AppError(message, 400, 'BAD_REQUEST', details);

export const Unauthorized = (message = 'Authentication required', details?: ErrorDetails) =>
  new AppError(message, 401, 'UNAUTHORIZED', details);

export const Forbidden = (message = 'You do not have permission to perform this action', details?: ErrorDetails) =>
  new AppError(message, 403, 'FORBIDDEN', details);

export const NotFound = (resource = 'Resource', details?: ErrorDetails) =>
  new AppError(`${resource} not found`, 404, 'NOT_FOUND', details);

export const Conflict = (message = 'Conflict', details?: ErrorDetails) =>
  new AppError(message, 409, 'CONFLICT', details);

export const Unprocessable = (message = 'Unprocessable entity', details?: ErrorDetails) =>
  new AppError(message, 422, 'UNPROCESSABLE_ENTITY', details);

export const TooManyRequests = (message = 'Too many requests', details?: ErrorDetails) =>
  new AppError(message, 429, 'TOO_MANY_REQUESTS', details);

export const PaymentRequired = (message = 'Subscription required', details?: ErrorDetails) =>
  new AppError(message, 402, 'PAYMENT_REQUIRED', details);
