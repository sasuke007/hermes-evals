/**
 * The error bodies the suites endpoints answer with: `{ statusCode, message }`,
 * worded like the web's fixture errors ("suite <id> not found").
 */
import {
  BadRequestException,
  GatewayTimeoutException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

export const notFound = (what: string): NotFoundException =>
  new NotFoundException({ statusCode: 404, message: `${what} not found` });

export const badRequest = (message: string): BadRequestException =>
  new BadRequestException({ statusCode: 400, message });

export const unavailable = (message: string): ServiceUnavailableException =>
  new ServiceUnavailableException({ statusCode: 503, message });

export const gatewayTimeout = (message: string): GatewayTimeoutException =>
  new GatewayTimeoutException({ statusCode: 504, message });

export const serverError = (message: string): InternalServerErrorException =>
  new InternalServerErrorException({ statusCode: 500, message });
