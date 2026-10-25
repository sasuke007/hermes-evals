import { Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiConflictResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  NousLoginSchema,
  ProviderInfoSchema,
  type NousLogin,
  type ProviderInfo,
} from '@hermes-evals/shared';
import { ApiJsonResponse } from '../openapi/decorators.js';
import { ProvidersService } from './providers.service.js';

/**
 * Model access (plan 6.1, section 11). The three state-changing routes pass
 * RequestedWithGuard like every other: a JSON body type and X-Requested-With,
 * so another site in the user's browser cannot log them in or out. Bodies are
 * not read.
 */
@ApiTags('providers')
@Controller('providers')
export class ProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Get()
  @ApiJsonResponse(ProviderInfoSchema, {
    array: true,
    description: 'Every provider, how it authenticates, and its status (presence only for keys)',
  })
  list(): Promise<ProviderInfo[]> {
    return this.providers.list();
  }

  @Post('nous/login')
  @HttpCode(200)
  @ApiJsonResponse(NousLoginSchema, {
    description: 'Started: the user code, the link and the expiry (or how it ended at once)',
  })
  @ApiConflictResponse({ description: "Host mode: this stack uses this machine's Hermes login" })
  @ApiServiceUnavailableResponse({ description: 'The nous-login service cannot log in now' })
  @ApiBadGatewayResponse({ description: 'nous-login answered something unexpected' })
  startLogin(): Promise<NousLogin> {
    return this.providers.startLogin();
  }

  @Get('nous/login')
  @ApiJsonResponse(NousLoginSchema, {
    description: 'The current device login (polled while waiting)',
  })
  getLogin(): Promise<NousLogin> {
    return this.providers.getLogin();
  }

  @Delete('nous/login')
  @ApiJsonResponse(NousLoginSchema, { description: 'Cancelled: the login after the cancel' })
  @ApiServiceUnavailableResponse({ description: 'The nous-login service cannot be reached' })
  cancelLogin(): Promise<NousLogin> {
    return this.providers.cancelLogin();
  }

  @Post('nous/logout')
  @HttpCode(200)
  @ApiJsonResponse(NousLoginSchema, {
    description: 'Disconnected, as `hermes logout --provider nous`',
  })
  @ApiServiceUnavailableResponse({ description: 'The nous-login service cannot be reached' })
  logout(): Promise<NousLogin> {
    return this.providers.logout();
  }
}
