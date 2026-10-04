import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
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
      // Non-HTTP throw (bug, TypeORM error, axios bubble) — log the real
      // error, return nothing identifying to the caller.
      this.logger.error(
        `Unhandled ${req.method} ${req.url}: ${errMsg(exception)}`,
      );
    }

    res.status(status).json({
      code,
      message,
      requestId: req.requestId ?? undefined,
    });
  }
}
