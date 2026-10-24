/**
 * HTTP helpers shared by the skill and document endpoints.
 *
 * The exceptions have exactly the body `{ statusCode, message }`, the error
 * shape of plan section 11: Nest sends an object passed to an HttpException
 * as the body unchanged, while a string would add an `error` field.
 */
import {
  BadRequestException,
  ConflictException,
  GoneException,
  NotFoundException,
  PayloadTooLargeException,
  type StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';

export const badRequest = (message: string) =>
  new BadRequestException({ statusCode: 400, message });

export const notFound = (message: string) => new NotFoundException({ statusCode: 404, message });

export const conflict = (message: string) => new ConflictException({ statusCode: 409, message });

export const gone = (message: string) => new GoneException({ statusCode: 410, message });

export const payloadTooLarge = (message: string) =>
  new PayloadTooLargeException({ statusCode: 413, message });

/** A filename safe inside a quoted header parameter: printable ASCII without `"` or `\`. */
const asciiFallback = (filename: string): string => filename.replace(/[^\x20-\x7e]|["\\]/g, '_');

/**
 * Content-Disposition for a download. The plain `filename` is an ASCII
 * fallback; `filename*` (RFC 6266 / 5987) carries the real UTF-8 name.
 */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${type}; filename="${asciiFallback(filename)}"; filename*=UTF-8''${encoded}`;
}

/**
 * Error handler for a StreamableFile. Before the headers go out it answers
 * 500 (the error itself may name a path, so it is not sent); after, it cuts
 * the connection, so a download fails visibly instead of ending truncated.
 */
/** The response StreamableFile hands its error handler (Nest does not export the type). */
type StreamableResponse = Parameters<Parameters<StreamableFile['setErrorHandler']>[0]>[1];

export function streamFailure(_err: Error, res: StreamableResponse): void {
  if (res.destroyed) return;
  // The platform is Express, so the response has its full API.
  const express = res as unknown as Response;
  if (res.headersSent) {
    express.destroy();
    return;
  }
  express.status(500).json({ statusCode: 500, message: 'could not read the stored file' });
}
