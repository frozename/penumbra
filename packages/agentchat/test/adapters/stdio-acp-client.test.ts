import { describe, it, expect, mock } from 'bun:test';
import { PassThrough } from 'node:stream';
import { StdioAcpClient } from '../../src/adapters/stdio-acp-client.js';

describe('StdioAcpClient', () => {
  describe('framing: newline (default)', () => {
    it('writes line-delimited JSON', async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const client = new StdioAcpClient({ stdin, stdout });

      const reqPromise = client.request('test/method', { foo: 'bar' });
      
      const written = stdin.read().toString('utf8');
      expect(written).toMatch(/{"jsonrpc":"2\.0","method":"test\/method","params":{"foo":"bar"},"id":1}\n/);

      stdout.write('{"jsonrpc":"2.0","id":1,"result":"ok"}\n');
      const result = await reqPromise;
      expect(result).toBe('ok');
    });

    it('reads line-delimited JSON and handles notifications', async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const client = new StdioAcpClient({ stdin, stdout });

      const handler = mock();
      client.on('test/notification', handler);

      stdout.write('{"jsonrpc":"2.0","method":"test/notification","params":{"event":"fired"}}\n');

      // Yield event loop
      await new Promise((r) => setTimeout(r, 10));

      expect(handler).toHaveBeenCalledWith({ event: 'fired' });
    });
  });

  describe('framing: newline — non-JSON lines', () => {
    it('silently skips non-JSON status lines without logging or breaking subsequent messages', async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const client = new StdioAcpClient({ stdin, stdout });

      const handler = mock();
      client.on('test/notification', handler);

      const consoleErrorSpy = mock();
      const originalError = console.error;
      console.error = consoleErrorSpy;

      try {
        stdout.write('Created\n');
        stdout.write('Expanding\n');
        stdout.write('Hook\n');
        stdout.write('{"jsonrpc":"2.0","method":"test/notification","params":{"after":"junk"}}\n');

        await new Promise((r) => setTimeout(r, 10));

        expect(handler).toHaveBeenCalledWith({ after: 'junk' });
        expect(consoleErrorSpy).not.toHaveBeenCalled();
      } finally {
        console.error = originalError;
      }
    });

    it('logs once for malformed JSON and continues processing subsequent messages', async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const client = new StdioAcpClient({ stdin, stdout });

      const handler = mock();
      client.on('test/notification', handler);

      const consoleErrorSpy = mock();
      const originalError = console.error;
      console.error = consoleErrorSpy;

      try {
        stdout.write('{not-real-json\n');
        stdout.write('{"jsonrpc":"2.0","method":"test/notification","params":{"recovered":true}}\n');

        await new Promise((r) => setTimeout(r, 10));

        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith({ recovered: true });
      } finally {
        console.error = originalError;
      }
    });
  });

  describe('framing: content-length', () => {
    it('writes Content-Length framed JSON', async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const client = new StdioAcpClient({ stdin, stdout, framing: 'content-length' });

      const reqPromise = client.request('test/method', { foo: 'bar' });
      
      const written = stdin.read().toString('utf8');
      const expectedJson = '{"jsonrpc":"2.0","method":"test/method","params":{"foo":"bar"},"id":1}';
      const expectedHeader = `Content-Length: ${Buffer.byteLength(expectedJson, 'utf8')}\r\n\r\n`;
      expect(written).toBe(expectedHeader + expectedJson);

      const respJson = '{"jsonrpc":"2.0","id":1,"result":"framed-ok"}';
      stdout.write(`Content-Length: ${Buffer.byteLength(respJson, 'utf8')}\r\n\r\n${respJson}`);
      
      const result = await reqPromise;
      expect(result).toBe('framed-ok');
    });

    it('reads Content-Length framed JSON in split chunks', async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const client = new StdioAcpClient({ stdin, stdout, framing: 'content-length' });

      const reqPromise = client.request('test/split', {});

      // Simulate a read that arrives in multiple chunks
      const respJson = '{"jsonrpc":"2.0","id":1,"result":"split-ok"}';
      const fullMessage = `Content-Length: ${Buffer.byteLength(respJson, 'utf8')}\r\n\r\n${respJson}`;
      
      const chunk1 = fullMessage.substring(0, 20);
      const chunk2 = fullMessage.substring(20, 30);
      const chunk3 = fullMessage.substring(30);

      stdout.write(chunk1);
      await new Promise((r) => setTimeout(r, 5));
      stdout.write(chunk2);
      await new Promise((r) => setTimeout(r, 5));
      stdout.write(chunk3);

      const result = await reqPromise;
      expect(result).toBe('split-ok');
    });

    it('handles malformed JSON cleanly and recovers', async () => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const client = new StdioAcpClient({ stdin, stdout, framing: 'content-length' });

      const reqPromise = client.request('test/recover', {});

      // Send a malformed message
      const badJson = '{"jsonrpc":"2.0","id":999, BAD}';
      stdout.write(`Content-Length: ${Buffer.byteLength(badJson, 'utf8')}\r\n\r\n${badJson}`);

      // Send the good message
      const goodJson = '{"jsonrpc":"2.0","id":1,"result":"recovered"}';
      stdout.write(`Content-Length: ${Buffer.byteLength(goodJson, 'utf8')}\r\n\r\n${goodJson}`);

      const result = await reqPromise;
      expect(result).toBe('recovered');
    });
  });
});
