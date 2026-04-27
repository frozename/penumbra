import {
  AcpSession,
  AcpCreateSessionRequest,
  AcpMessageRequest,
  AcpEvent,
  AcpTool,
  AcpPermissionReply,
  AcpPermissionResponse
} from './acp-types.js';

export interface AcpClientOptions {
  baseUrl: string;
  signal?: AbortSignal;
}

/**
 * HTTP/SSE client for the OpenCode Agent Client Protocol (ACP).
 * Implements session management and prompt dispatch with streaming events.
 */
export class AcpClient {
  private readonly baseUrl: string;
  private readonly signal?: AbortSignal;

  constructor(opts: AcpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.signal = opts.signal;
  }

  /**
   * Opens a new ACP session.
   * @POST /session
   */
  async openSession(req: AcpCreateSessionRequest = {}): Promise<{ sessionId: string; workspaceId?: string }> {
    const res = await fetch(`${this.baseUrl}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal: this.signal,
    });
    if (!res.ok) {
      const errorText = await res.text().catch(() => 'No error body');
      throw new Error(`ACP openSession failed (HTTP ${res.status}): ${errorText}`);
    }
    const data = (await res.json()) as { id?: string; sessionID?: string; session?: string; workspaceID?: string; workspace?: string };
    const sessionId = data.sessionID ?? data.id ?? data.session;
    const workspaceId = data.workspaceID ?? data.workspace;
    if (!sessionId) {
      throw new Error('ACP openSession failed: missing session id in response');
    }
    return { sessionId, workspaceId };
  }

  /**
   * Closes an existing ACP session.
   * @DELETE /session/{sessionId}
   */
  async closeSession(sessionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/session/${sessionId}`, {
      method: 'DELETE',
      signal: this.signal,
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`ACP closeSession failed (HTTP ${res.status})`);
    }
  }

  /**
   * Sends a message to a session and returns an event stream.
   * Internally manages the SSE subscription to /event.
   */
  async *sendMessage(
    sessionId: string,
    content: string,
    opts?: {
      tools?: AcpTool[];
      model?: string;
      agent?: string;
      directory?: string;
      workspace?: string;
    }
  ): AsyncIterable<AcpEvent> {
    const directory = opts?.directory ?? '.';
    // OpenCode's /event endpoint validates `workspace` as a wrk_* prefixed
    // workspace id; passing any other value (e.g. '.', a directory path) yields
    // HTTP 500 (Zod "must start with wrk"). POST /session does NOT return a
    // workspace id either, so the safe default is to omit the query param.
    // Only set it when the caller has a real wrk_* id.
    const workspace = opts?.workspace;

    // 1. Subscribe to the event stream
    const eventStream = this.subscribeEvents(directory, workspace, sessionId);

    // 2. Dispatch the message POST. OpenCode validates the request body strictly:
    //    - messageID must start with "msg_"
    //    - model must be { providerID?, modelID } object, NOT a plain string
    //    - tools must be a record (object keyed by tool name), NOT an array
    //    Build the wire shape here so callers keep the convenient string form.
    const modelOpt = opts?.model;
    let modelObj: { providerID?: string; modelID: string };
    if (typeof modelOpt === 'object' && modelOpt !== null) {
      modelObj = modelOpt as { providerID?: string; modelID: string };
    } else if (typeof modelOpt === 'string' && modelOpt.includes('/')) {
      const slash = modelOpt.indexOf('/');
      modelObj = { providerID: modelOpt.slice(0, slash), modelID: modelOpt.slice(slash + 1) };
    } else {
      modelObj = { modelID: modelOpt ?? 'default' };
    }
    const toolsRecord: Record<string, AcpTool> = {};
    for (const t of opts?.tools ?? []) toolsRecord[t.name] = t;

    const messageRequest = {
      messageID: 'msg_' + crypto.randomUUID().replace(/-/g, ''),
      model: modelObj,
      // OpenCode rejects agent='default' with "Agent not found"; its built-in
      // agents are build/explorer/etc. 'build' is the standard starting agent.
      agent: opts?.agent ?? 'build',
      tools: toolsRecord,
      parts: [{ type: 'text', text: content }],
    };

    const sendPromise = fetch(`${this.baseUrl}/session/${sessionId}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messageRequest),
      signal: this.signal,
    }).then(async (res) => {
      if (!res.ok) {
        const errorText = await res.text().catch(() => 'No error body');
        throw new Error(`ACP sendMessage failed (HTTP ${res.status}): ${errorText}`);
      }
    });

    let sendError: Error | undefined;
    sendPromise.catch((err) => {
      sendError = err;
    });

    // 3. Yield events until 'done' or error
    for await (const event of eventStream) {
      if (sendError) throw sendError;
      yield event;
      if (event.type === 'done') break;
    }
    
    // Ensure the send actually finished if we didn't get a 'done' event but the stream closed
    await sendPromise;
  }

  /**
   * Subscribes to the workspace-level event stream.
   * @GET /event?directory=...&sessionID=...[&workspace=wrk_...]
   *
   * `workspace` is optional and only included when it's a real wrk_* id.
   * OpenCode's server rejects any non-prefixed value with HTTP 500.
   */
  private async *subscribeEvents(directory: string, workspace: string | undefined, sessionId: string): AsyncIterable<AcpEvent> {
    const url = new URL(`${this.baseUrl}/event`);
    url.searchParams.set('directory', directory);
    if (workspace) url.searchParams.set('workspace', workspace);
    url.searchParams.set('sessionID', sessionId);

    const res = await fetch(url.toString(), {
      headers: {
        'Accept': 'text/event-stream',
      },
      signal: this.signal,
    });
    
    if (!res.ok) {
      const errorText = await res.text().catch(() => 'No error body');
      throw new Error(`ACP subscribeEvents failed (HTTP ${res.status}): ${errorText}`);
    }
    if (!res.body) {
      throw new Error('ACP subscribeEvents: response body is empty');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          for (const line of chunk.split('\n')) {
            if (line.startsWith('data:')) {
              const data = line.slice(5).trim();
              if (!data || data === '[DONE]') continue;
              try {
                const event = JSON.parse(data) as AcpEvent;
                yield event;
              } catch (err) {
                // Ignore parse errors for partial or malformed events
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Reply to a permission request.
   * @POST /permission/{requestID}/reply
   */
  async replyPermission(requestID: string, reply: AcpPermissionReply): Promise<void> {
    const res = await fetch(`${this.baseUrl}/permission/${requestID}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(reply),
      signal: this.signal,
    });
    if (!res.ok) throw new Error(`ACP replyPermission failed (HTTP ${res.status})`);
  }

  /**
   * Respond to a specific session permission.
   * @POST /session/{sessionId}/permissions/{permissionID}
   */
  async respondPermission(sessionId: string, permissionID: string, response: AcpPermissionResponse): Promise<void> {
    const res = await fetch(`${this.baseUrl}/session/${sessionId}/permissions/${permissionID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(response),
      signal: this.signal,
    });
    if (!res.ok) throw new Error(`ACP respondPermission failed (HTTP ${res.status})`);
  }
}
