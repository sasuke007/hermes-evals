/**
 * The DNS-rebinding defences (plan 6.1): the Host allowlist in front of every
 * route, and the Origin rule RequestedWithGuard applies to state-changing
 * requests. Driven through a Nest app set up the way configureApi sets it up.
 */
import { Body, Controller, Get, Post, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  HOST_NOT_ALLOWED,
  hostAllowlist,
  hostOf,
  hostPolicy,
  isAllowedHost,
  isAllowedOrigin,
} from './host-allowlist.js';
import {
  MISSING_REQUESTED_WITH,
  ORIGIN_NOT_ALLOWED,
  RequestedWithGuard,
  refusalOf,
} from './requested-with.guard.js';

const CORS_ORIGIN = 'http://localhost:8080';

@Controller('probe')
class ProbeController {
  @Get()
  read() {
    return { ok: true };
  }

  @Post()
  write(@Body() body: unknown) {
    return { ok: true, body };
  }
}

let app: INestApplication;

beforeAll(async () => {
  const env: Record<string, string> = { CORS_ORIGIN, ALLOWED_HOSTS: 'evals.lan, 192.168.1.20' };
  const moduleRef = await Test.createTestingModule({
    controllers: [ProbeController],
    providers: [
      { provide: ConfigService, useValue: { get: (key: string) => env[key] } },
      { provide: APP_GUARD, useClass: RequestedWithGuard },
    ],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.use(hostAllowlist(hostPolicy(CORS_ORIGIN, env.ALLOWED_HOSTS)));
  app.setGlobalPrefix('api');
  await app.init();
});

afterAll(async () => {
  await app.close();
});

const http = () => request(app.getHttpServer());
const post = (host: string, origin?: string) => {
  const req = http()
    .post('/api/probe')
    .set('Host', host)
    .set('X-Requested-With', 'hermes-evals')
    .set('content-type', 'application/json');
  return (origin ? req.set('Origin', origin) : req).send({ a: 1 });
};

describe('the Host allowlist', () => {
  it('refuses a foreign Host on reads, writes and unknown routes alike', async () => {
    for (const call of [
      () => http().get('/api/probe').set('Host', 'rebind.attacker.example:8080'),
      () => post('rebind.attacker.example:8080'),
      () => http().get('/api/nowhere').set('Host', 'rebind.attacker.example'),
    ]) {
      const res = await call().expect(403);
      expect(res.body).toEqual({ statusCode: 403, message: HOST_NOT_ALLOWED });
    }
  });

  it('answers the names the API is reached by', async () => {
    for (const host of [
      'localhost:8080',
      '127.0.0.1:8080',
      '[::1]:3000',
      'api:3000',
      'LOCALHOST',
      'evals.lan',
      '192.168.1.20:8080',
    ]) {
      await http().get('/api/probe').set('Host', host).expect(200);
    }
  });

  it('reads the host name out of a Host value', () => {
    expect(hostOf('LocalHost:8080')).toBe('localhost');
    expect(hostOf('[::1]:3000')).toBe('::1');
    expect(hostOf('::1')).toBe('::1');
    expect(hostOf('api')).toBe('api');
    expect(hostOf('')).toBeNull();
    expect(hostOf(undefined)).toBeNull();
    const policy = hostPolicy('http://localhost:5173');
    expect(isAllowedHost(policy, undefined)).toBe(false);
    expect(isAllowedHost(policy, 'localhost.attacker.example')).toBe(false);
  });
});

describe('the Origin rule', () => {
  it('refuses a state-changing request from another origin, and Origin null', async () => {
    for (const origin of ['http://rebind.attacker.example:8080', 'null', 'file://']) {
      const res = await post('localhost:8080', origin).expect(403);
      expect(res.body).toEqual({ statusCode: 403, message: ORIGIN_NOT_ALLOWED });
    }
  });

  it('lets the web app (nginx), the Vite proxy, Swagger and clients without Origin through', async () => {
    await post('localhost:8080', 'http://localhost:8080').expect(201);
    await post('127.0.0.1:8080', 'http://127.0.0.1:8080').expect(201);
    // The Vite proxy rewrites Host but keeps the page's Origin.
    await post('localhost:3000', 'http://localhost:5173').expect(201);
    await post('localhost:3000', 'http://localhost:3000').expect(201);
    await post('api:3000').expect(201);
  });

  it('keeps the X-Requested-With rule ahead of it', async () => {
    const res = await http()
      .post('/api/probe')
      .set('Host', 'localhost')
      .set('Origin', CORS_ORIGIN)
      .send({})
      .expect(403);
    expect(res.body).toEqual({ statusCode: 403, message: MISSING_REQUESTED_WITH });
  });

  it('is applied by refusalOf only with a policy, and only to state-changing methods', () => {
    const policy = hostPolicy(CORS_ORIGIN);
    const headers = {
      'x-requested-with': 'x',
      'content-type': 'application/json',
      origin: 'https://evil.example',
    };
    expect(refusalOf('POST', headers, policy)).toBe(ORIGIN_NOT_ALLOWED);
    expect(refusalOf('POST', headers)).toBeNull();
    expect(refusalOf('GET', headers, policy)).toBeNull();
    expect(isAllowedOrigin(policy, CORS_ORIGIN)).toBe(true);
    expect(isAllowedOrigin(policy, 'ftp://localhost')).toBe(false);
    expect(isAllowedOrigin(policy, 'not a url')).toBe(false);
  });
});
