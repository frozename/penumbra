import { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: any;
  id: string | number;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
  id: string | number | null;
}

export interface StdioAcpClientOptions {
  stdin: Writable;
  stdout: Readable;
  framing?: 'newline' | 'content-length';
}

export class StdioAcpClient {
  private nextId = 1;
  private pendingRequests = new Map<string | number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  private handlers = new Map<string, (params: any) => void>();
  private framing: 'newline' | 'content-length';

  // For content-length framing
  private buffer: Buffer = Buffer.alloc(0);
  private contentLength: number | null = null;

  constructor(private readonly options: StdioAcpClientOptions) {
    this.framing = options.framing ?? 'newline';

    if (this.framing === 'newline') {
      const rl = createInterface({
        input: this.options.stdout,
        terminal: false,
      });

      rl.on('line', (line) => {
        if (!line.trim()) return;
        try {
          const message = JSON.parse(line);
          this.handleMessage(message);
        } catch (err) {
          console.error('stdio-acp-client: failed to parse JSON-RPC message:', err);
        }
      });
    } else {
      this.options.stdout.on('data', (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.processBuffer();
      });
    }

    this.options.stdout.on('close', () => {
      const err = new Error('stdio-acp-client: transport closed');
      for (const req of this.pendingRequests.values()) {
        req.reject(err);
      }
      this.pendingRequests.clear();
    });
  }

  private processBuffer() {
    while (true) {
      if (this.contentLength === null) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          // Incomplete header
          break;
        }

        const headerStr = this.buffer.toString('utf8', 0, headerEnd);
        const match = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (match) {
          this.contentLength = parseInt(match[1], 10);
        } else {
          console.error('stdio-acp-client: missing Content-Length in header');
          // Try to recover by dropping header
        }
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }

      if (this.contentLength !== null) {
        if (this.buffer.length >= this.contentLength) {
          const bodyBuffer = this.buffer.subarray(0, this.contentLength);
          this.buffer = this.buffer.subarray(this.contentLength);
          this.contentLength = null;

          const bodyStr = bodyBuffer.toString('utf8');
          if (!bodyStr.trim()) continue;

          try {
            const message = JSON.parse(bodyStr);
            this.handleMessage(message);
          } catch (err) {
            console.error('stdio-acp-client: failed to parse framed JSON-RPC message:', err);
          }
        } else {
          // Incomplete body
          break;
        }
      }
    }
  }

  private writeMessage(message: any) {
    const jsonStr = JSON.stringify(message);
    if (this.framing === 'content-length') {
      const byteLen = Buffer.byteLength(jsonStr, 'utf8');
      this.options.stdin.write(`Content-Length: ${byteLen}\r\n\r\n${jsonStr}`);
    } else {
      this.options.stdin.write(jsonStr + '\n');
    }
  }

  async request(method: string, params?: any): Promise<any> {
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      this.writeMessage(request);
    });
  }

  notify(method: string, params?: any): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.writeMessage(notification);
  }

  on(method: string, handler: (params: any) => void): void {
    this.handlers.set(method, handler);
  }

  private handleMessage(message: any): void {
    if (message.id !== undefined) {
      // Response
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(`stdio-acp-client: ${message.error.message} (code: ${message.error.code})`));
        } else {
          pending.resolve(message.result);
        }
      }
    } else if (message.method) {
      // Notification or Request (treating as notification for now)
      const handler = this.handlers.get(message.method);
      if (handler) {
        handler(message.params);
      }
    }
  }
}
