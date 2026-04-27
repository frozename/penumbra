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
}

export class StdioAcpClient {
  private nextId = 1;
  private pendingRequests = new Map<string | number, { resolve: (val: any) => void; reject: (err: Error) => void }>();
  private handlers = new Map<string, (params: any) => void>();

  constructor(private readonly options: StdioAcpClientOptions) {
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

    this.options.stdout.on('close', () => {
      const err = new Error('stdio-acp-client: transport closed');
      for (const req of this.pendingRequests.values()) {
        req.reject(err);
      }
      this.pendingRequests.clear();
    });
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
      this.options.stdin.write(JSON.stringify(request) + '\n');
    });
  }

  notify(method: string, params?: any): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.options.stdin.write(JSON.stringify(notification) + '\n');
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
