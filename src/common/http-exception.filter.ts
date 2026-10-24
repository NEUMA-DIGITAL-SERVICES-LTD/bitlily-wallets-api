import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { EntityNotFoundError, QueryFailedError } from 'typeorm';
import { isAxiosError } from 'axios';
import { errMsg } from './errors';

/**
 * Every error leaves as { code, message, requestId } — clients get a
 * stable machine-readable contract and internals (stack traces, upstream
 * hostnames, axios internals) never leak. Unhandled errors are logged
 * server-side with full detail and reported as INTERNAL_ERROR only.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { requestId?: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      // class-validator errors arrive as { message: string[] } — flatten
      // to a single readable message so clients can display it.
      const raw =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)
          : {};
      const msgs = raw.message;
      message = Array.isArray(msgs)
        ? msgs.join('; ')
        : String(msgs ?? exception.message);
      code = String(raw.error ?? HttpStatus[status] ?? 'ERROR')
        .replace(/\s+/g, '_')
        .toUpperCase();
      // Domain-specific codes where the generic status text loses meaning.
      if (status === HttpStatus.BAD_GATEWAY) code = 'PROVIDER_ERROR';
    } else {
      // Non-HTTP throw — translate KNOWN infra failures into honest
      // client errors (DB constraint, upstream provider, not-found).
      // Anything unrecognized stays masked: internals never leak.
      const mapped = mapInfraError(exception);
      if (mapped) {
        ({ status, code, message } = mapped);
        this.logger.warn(
          `${code} on ${req.method} ${req.url}: ${errMsg(exception)}`,
        );
      } else {
        this.logger.error(
          `Unhandled ${req.method} ${req.url}: ${errMsg(exception)}`,
        );
      }
    }

    res.status(status).json({
      code,
      message,
      requestId: req.requestId ?? undefined,
    });
  }
}

/**
 * Expected infrastructure failures → the friendly code they should have
 * carried. These aren't bugs — a caller CAN act on them (bad UUID format,
 * upstream provider down, record gone). True bugs return null and stay
 * masked as INTERNAL_ERROR.
 */
function mapInfraError(
  e: unknown,
): { status: number; code: string; message: string } | null {
  if (e instanceof QueryFailedError) {
    const pg = (e as { code?: string }).code;
    switch (pg) {
      case '23505':
        return { status: 409, code: 'CONFLICT', message: 'A conflicting record already exists — the value violates a uniqueness rule' };
      case '23503':
        return { status: 409, code: 'CONFLICT', message: 'Referenced record does not exist' };
      case '23502':
        return { status: 400, code: 'BAD_REQUEST', message: 'A required field was missing' };
      case '22P02':
        return { status: 400, code: 'BAD_REQUEST', message: 'Malformed identifier — expected a UUID or number' };
      default:
        return { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'Database error — retry shortly' };
    }
  }
  if (e instanceof EntityNotFoundError) {
    return { status: 404, code: 'NOT_FOUND', message: 'The requested resource was not found' };
  }
  if (isAxiosError(e)) {
    const upstream = e.response?.status;
    if (upstream) {
      return { status: 502, code: 'PROVIDER_ERROR', message: `Upstream blockchain provider returned HTTP ${upstream}` };
    }
    if (e.code === 'ECONNABORTED' || /timed? ?out/i.test(e.message ?? '')) {
      return { status: 504, code: 'PROVIDER_TIMEOUT', message: 'Upstream blockchain provider timed out' };
    }
    return { status: 503, code: 'PROVIDER_UNREACHABLE', message: 'Upstream blockchain provider unreachable' };
  }
  // Middleware-style errors carry their own HTTP status (body-parser,
  // malformed JSON, payload too large) — honor it, keep the message.
  const status = (e as { status?: number; statusCode?: number }).status
    ?? (e as { statusCode?: number }).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return {
      status,
      code: HttpStatus[status]?.replace(/\s+/g, '_').toUpperCase() ?? 'ERROR',
      message: errMsg(e),
    };
  }
  return null;
}
