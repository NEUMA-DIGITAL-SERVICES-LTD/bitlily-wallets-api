import { ApiProperty } from '@nestjs/swagger';

/**
 * Uniform error contract — every non-2xx from the service passes through
 * HttpExceptionFilter and lands in this shape. `requestId` correlates to
 * server logs; `code` is a stable machine token (message wording is not
 * contractual).
 */
export class ErrorResponseDto {
  @ApiProperty({ example: 'BAD_REQUEST' })
  code: string;

  @ApiProperty()
  message: string;

  @ApiProperty()
  requestId: string;
}
