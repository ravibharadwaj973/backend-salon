import type { NextFunction, Request, RequestHandler, Response } from 'express';

export type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Wrap an async route so rejected promises reach the error middleware. */
export function asyncHandler(fn: AsyncHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export interface Meta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
}

export function ok<T>(res: Response, data: T, meta?: Record<string, unknown>): Response {
  return res.status(200).json({ success: true, data, ...(meta ? { meta } : {}) });
}

export function created<T>(res: Response, data: T): Response {
  return res.status(201).json({ success: true, data });
}

export function noContent(res: Response): Response {
  return res.status(204).send();
}

export function paginated<T>(res: Response, items: T[], total: number, page: number, pageSize: number): Response {
  const meta: Meta = {
    page,
    pageSize,
    total,
    totalPages: pageSize > 0 ? Math.ceil(total / pageSize) : 0,
    hasMore: page * pageSize < total,
  };
  return res.status(200).json({ success: true, data: items, meta });
}

export interface PageParams {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export function pageParams(input: { page?: number; pageSize?: number }): PageParams {
  const page = Math.max(1, Number(input.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Number(input.pageSize ?? 25)));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function sortParams<T extends string>(
  sortBy: T | undefined,
  sortDir: 'asc' | 'desc' | undefined,
  fallback: T,
): Record<string, 'asc' | 'desc'> {
  return { [sortBy ?? fallback]: sortDir ?? 'desc' };
}
