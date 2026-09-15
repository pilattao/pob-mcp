import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import * as net from 'net';
import { PoBLuaTcpClient } from '../../src/pobLuaBridge.js';

// ── Minimal mock TCP server ───────────────────────────────────────────────────

interface MockServer {
  server: net.Server;
  port: number;
  lastSocket: net.Socket | null;
  send(obj: object): void;
  close(): Promise<void>;
}

function createMockServer(
  onConnect?: (sock: net.Socket) => void
): Promise<MockServer> {
  return new Promise((resolve) => {
    let lastSocket: net.Socket | null = null;
    const sockets = new Set<net.Socket>();
    const server = net.createServer((sock) => {
      lastSocket = sock;
      sockets.add(sock);
      sock.once('close', () => sockets.delete(sock));
      if (onConnect) onConnect(sock);
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        server,
        port,
        get lastSocket() { return lastSocket; },
        send(obj: object) {
          lastSocket?.write(JSON.stringify(obj) + '\n');
        },
        close() {
          // Destroy all open connections so server.close() resolves promptly.
          for (const s of sockets) { try { s.destroy(); } catch {} }
          return new Promise((res) => server.close(() => res()));
        },
      });
    });
  });
}

const BANNER = { ok: true, ready: true, version: { apiVersion: '1.0.0', mode: 'tcp', number: '2.65.0', branch: 'master', platform: 'win32' } };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PoBLuaTcpClient', () => {
  let mock: MockServer;
  let client: PoBLuaTcpClient;

  afterEach(async () => {
    try { await client?.stop(); } catch {}
    await mock?.close();
  });

  describe('start() / banner handshake', () => {
    it('connects and reads the ready banner', async () => {
      mock = await createMockServer((sock) => {
        setTimeout(() => sock.write(JSON.stringify(BANNER) + '\n'), 10);
      });
      client = new PoBLuaTcpClient({ port: mock.port, timeoutMs: 2000 });
      await expect(client.start()).resolves.toBeUndefined();
      expect(client.isAlive()).toBe(true);
    });

    it('ignores non-JSON lines before the banner', async () => {
      mock = await createMockServer((sock) => {
        setTimeout(() => {
          sock.write('Loading...\n');
          sock.write('Another log line\n');
          sock.write(JSON.stringify(BANNER) + '\n');
        }, 10);
      });
      client = new PoBLuaTcpClient({ port: mock.port, timeoutMs: 2000 });
      await expect(client.start()).resolves.toBeUndefined();
      expect(client.isAlive()).toBe(true);
    });

    it('rejects if banner never arrives (timeout)', async () => {
      mock = await createMockServer(); // never sends banner
      client = new PoBLuaTcpClient({ port: mock.port, timeoutMs: 150 });
      await expect(client.start()).rejects.toThrow(/Timed out/);
      expect(client.isAlive()).toBe(false);
    });

    it('rejects when no service is listening', async () => {
      // Use a port we know was bound locally; a hard-coded port can be filtered
      // by a host firewall and time out instead of refusing a connection.
      const closedServer = await createMockServer();
      await closedServer.close();
      client = new PoBLuaTcpClient({ port: closedServer.port, timeoutMs: 500 });
      await expect(client.start()).rejects.toThrow(/Cannot connect|ECONNREFUSED|ECONNRESET/);
    });

    it('marks killed when server closes the connection', async () => {
      mock = await createMockServer((sock) => {
        setTimeout(() => {
          sock.write(JSON.stringify(BANNER) + '\n');
          setTimeout(() => sock.destroy(), 50);
        }, 10);
      });
      client = new PoBLuaTcpClient({ port: mock.port, timeoutMs: 2000 });
      await client.start();
      await new Promise((r) => setTimeout(r, 150));
      expect(client.isAlive()).toBe(false);
    });
  });

  describe('timeout behaviour', () => {
    it('rejects on timeout waiting for response', async () => {
      // Server sends banner but never responds to requests
      const silentMock = await createMockServer((sock) => {
        setTimeout(() => sock.write(JSON.stringify(BANNER) + '\n'), 10);
        // deliberately no 'data' listener — requests go unanswered
      });
      const silentClient = new PoBLuaTcpClient({ port: silentMock.port, timeoutMs: 150 });
      try {
        await silentClient.start();
        await expect(silentClient.getBuildInfo()).rejects.toThrow(/Timed out/);
      } finally {
        await silentClient.stop();
        await silentMock.close();
      }
    }, 3000);
  });

  describe('request/response round-trip', () => {
    beforeEach(async () => {
      mock = await createMockServer((sock) => {
        setTimeout(() => sock.write(JSON.stringify(BANNER) + '\n'), 10);
        sock.on('data', (chunk) => {
          const lines = chunk.toString().split('\n').filter(Boolean);
          for (const line of lines) {
            try {
              const req = JSON.parse(line);
              if (req.action === 'get_build_info') {
                sock.write(JSON.stringify({ ok: true, info: { name: 'Test Build', level: 90, className: 'Witch', treeVersion: '3_28' } }) + '\n');
              } else if (req.action === 'get_stats') {
                sock.write(JSON.stringify({ ok: true, stats: { Life: 5000, EnergyShield: 0 } }) + '\n');
              } else {
                sock.write(JSON.stringify({ ok: false, error: `unknown action: ${req.action}` }) + '\n');
              }
            } catch {}
          }
        });
      });
      client = new PoBLuaTcpClient({ port: mock.port, timeoutMs: 2000 });
      await client.start();
    });

    it('getBuildInfo returns build metadata', async () => {
      const info = await client.getBuildInfo();
      expect(info).toMatchObject({ name: 'Test Build', level: 90 });
    });

    it('getStats returns stat values', async () => {
      const stats = await client.getStats(['Life', 'EnergyShield']);
      expect(stats).toMatchObject({ Life: 5000 });
    });

    it('resolves with ok:false for unknown action (does not throw)', async () => {
      // send() propagates server errors as rejected promises only when the
      // higher-level method checks res.ok; raw send() resolves with the payload.
      const res = await (client as any).send({ action: 'nonexistent' });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/unknown action/);
    });

    it('higher-level method throws when server returns ok:false', async () => {
      // getBuildInfo checks res.ok and throws on error responses
      mock.lastSocket?.removeAllListeners('data');
      mock.lastSocket?.on('data', () => {
        mock.send({ ok: false, error: 'no build loaded' });
      });
      await expect(client.getBuildInfo()).rejects.toThrow(/no build loaded/);
    });
  });

  describe('stop()', () => {
    it('can reconnect the same client after disconnecting', async () => {
      mock = await createMockServer(sock => sock.write(JSON.stringify(BANNER) + '\n'));
      client = new PoBLuaTcpClient({ port: mock.port, timeoutMs: 2000 });
      await client.start();
      await client.stop();
      await client.start();
      expect(client.isAlive()).toBe(true);
    });

    it('disconnects without crashing and isAlive() returns false', async () => {
      mock = await createMockServer((sock) => {
        setTimeout(() => sock.write(JSON.stringify(BANNER) + '\n'), 10);
      });
      client = new PoBLuaTcpClient({ port: mock.port, timeoutMs: 2000 });
      await client.start();
      expect(client.isAlive()).toBe(true);
      await client.stop();
      expect(client.isAlive()).toBe(false);
    });

    it('is safe to call stop() multiple times', async () => {
      mock = await createMockServer((sock) => {
        setTimeout(() => sock.write(JSON.stringify(BANNER) + '\n'), 10);
      });
      client = new PoBLuaTcpClient({ port: mock.port, timeoutMs: 2000 });
      await client.start();
      await client.stop();
      await expect(client.stop()).resolves.toBeUndefined();
    });
  });
});
