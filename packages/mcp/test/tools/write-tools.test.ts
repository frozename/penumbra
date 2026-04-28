import { describe, it, expect, beforeEach } from 'bun:test';
import { z } from 'zod';
import { registerWriteTools } from '../../src/tools/write-tools.js';

class MockMcpServer {
  tools: Map<string, any> = new Map();

  registerTool(name: string, schema: any, handler: any) {
    this.tools.set(name, { schema, handler });
  }
}

function createMockExecutor() {
  return {
    writeTextFile: async () => ({ bytesWritten: 10, sha256: 'abc' }),
    editTextFile: async () => ({ applied: true, occurrences: 1 }),
    terminalCreate: async () => ({ terminal_id: 't1' }),
    terminalWaitForExit: async () => ({ exit_status: 0 }),
    terminalOutput: async () => ({ output: 'hello', truncated: false }),
    terminalRelease: async () => {},
  };
}

describe('Write Tools', () => {
  let server: MockMcpServer;
  let mockExecutor: any;
  let ctx: any;

  beforeEach(() => {
    server = new MockMcpServer();
    mockExecutor = createMockExecutor();
    ctx = {
      resolveExecutor: () => mockExecutor,
      dispatchId: 'd1',
    };
    registerWriteTools(server as any, ctx);
  });

  describe('Registration', () => {
    it('registers all tools', () => {
      expect(server.tools.has('fs.write_file')).toBe(true);
      expect(server.tools.has('fs.edit')).toBe(true);
      expect(server.tools.has('terminal.run')).toBe(true);
    });
  });

  describe('fs.write_file', () => {
    it('calls writeTextFile and returns success', async () => {
      let capturedArgs: any = null;
      mockExecutor.writeTextFile = async (args: any, c: any) => {
        capturedArgs = { args, c };
        return { bytesWritten: 100, sha256: 'sha123' };
      };

      const handler = server.tools.get('fs.write_file').handler;
      const res = await handler({ path: 'foo.txt', content: 'hello' });

      expect(capturedArgs.args).toEqual({ path: 'foo.txt', content: 'hello' });
      expect(capturedArgs.c.toolName).toBe('fs.write_file');
      expect(capturedArgs.c.dispatchId).toBe('d1');
      
      const body = JSON.parse(res.content[0].text);
      expect(body.ok).toBe(true);
      expect(body.bytesWritten).toBe(100);
    });

    it('surfaces errors from executor', async () => {
      mockExecutor.writeTextFile = async () => {
        const err: any = new Error('denied');
        err.code = 'operation_rejected';
        throw err;
      };

      const handler = server.tools.get('fs.write_file').handler;
      const res = await handler({ path: 'foo.txt', content: 'hello' });

      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text);
      expect(body.error.code).toBe('operation_rejected');
    });
  });

  describe('fs.edit', () => {
    it('calls editTextFile and returns success', async () => {
      let capturedArgs: any = null;
      mockExecutor.editTextFile = async (args: any, c: any) => {
        capturedArgs = { args, c };
        return { applied: true, occurrences: 1 };
      };

      const handler = server.tools.get('fs.edit').handler;
      const res = await handler({ path: 'foo.txt', old_string: 'a', new_string: 'b' });

      expect(capturedArgs.args).toEqual({ path: 'foo.txt', old_string: 'a', new_string: 'b' });
      const body = JSON.parse(res.content[0].text);
      expect(body.ok).toBe(true);
    });
  });

  describe('terminal.run', () => {
    it('executes full one-shot lifecycle', async () => {
      const calls: string[] = [];
      mockExecutor.terminalCreate = async () => { calls.push('create'); return { terminal_id: 't1' }; };
      mockExecutor.terminalWaitForExit = async () => { calls.push('wait'); return { exit_status: 0 }; };
      mockExecutor.terminalOutput = async () => { calls.push('output'); return { output: 'hi', truncated: false }; };
      mockExecutor.terminalRelease = async () => { calls.push('release'); };

      const handler = server.tools.get('terminal.run').handler;
      const res = await handler({ command: 'ls' });

      expect(calls).toEqual(['create', 'wait', 'output', 'release']);
      const body = JSON.parse(res.content[0].text);
      expect(body.ok).toBe(true);
      expect(body.output).toBe('hi');
      expect(body.exit_status).toBe(0);
    });

    it('releases terminal even if wait fails', async () => {
      let released = false;
      mockExecutor.terminalWaitForExit = async () => { throw new Error('timeout'); };
      mockExecutor.terminalRelease = async () => { released = true; };

      const handler = server.tools.get('terminal.run').handler;
      const res = await handler({ command: 'ls' });

      expect(released).toBe(true);
      expect(res.isError).toBe(true);
    });
  });

  describe('Context and Errors', () => {
    it('throws if executor cannot be resolved', async () => {
      ctx.resolveExecutor = () => null;
      const handler = server.tools.get('fs.write_file').handler;
      const res = await handler({ path: 'f', content: 'c' });
      expect(res.isError).toBe(true);
      const body = JSON.parse(res.content[0].text);
      expect(body.error.message).toContain('not available');
    });
  });
});
