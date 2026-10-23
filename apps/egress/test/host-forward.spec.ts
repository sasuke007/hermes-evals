import net from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { parseHostPort, startHostForward } from '../src/host-forward.js';

describe('parseHostPort', () => {
  it('reads host:port, including bracketed IPv6', () => {
    expect(parseHostPort('host.docker.internal:8645', 'X')).toEqual({
      host: 'host.docker.internal',
      port: 8645,
    });
    expect(parseHostPort('[::1]:8645', 'X')).toEqual({ host: '::1', port: 8645 });
  });
  it('refuses anything else', () => {
    for (const bad of ['host.docker.internal', 'x:0', 'x:70000', 'x:80"}', '']) {
      expect(() => parseHostPort(bad, 'X')).toThrow(/host:port/);
    }
  });
});

describe('startHostForward', () => {
  const servers: net.Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  it('listens only on loopback', () => {
    expect(() =>
      startHostForward({
        listen: { host: '0.0.0.0', port: 0 },
        target: { host: '127.0.0.1', port: 1 },
        log: () => {},
      }),
    ).toThrow(/loopback/);
  });

  it('forwards bytes both ways', async () => {
    const echo = net.createServer((s) => s.pipe(s));
    servers.push(echo);
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
    const forward = startHostForward({
      listen: { host: '127.0.0.1', port: 0 },
      target: { host: '127.0.0.1', port: (echo.address() as net.AddressInfo).port },
      log: () => {},
    });
    servers.push(forward);
    await new Promise<void>((r) =>
      forward.listening ? r() : forward.once('listening', () => r()),
    );
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect((forward.address() as net.AddressInfo).port, '127.0.0.1', () =>
        socket.write('ping'),
      );
      socket.once('data', (d) => {
        socket.destroy();
        resolve(d.toString());
      });
      socket.on('error', reject);
    });
    expect(reply).toBe('ping');
  });
});
