// Mid-session ACP messaging ultimately rides the worker-held stdio-acp JSON-RPC `session/prompt` path; this wrapper only locates the live handle by chain_handoff_id.
export interface AcpInjectMessage {
  role: 'user';
  text: string;
}

export interface AcpInjectableSessionLike {
  adapter?: string | null;
  adapter_kind?: string | null;
  metadata?: {
    adapter?: string | null;
    adapter_kind?: string | null;
  } | null;
  worker?: {
    adapter?: string | null;
    adapter_kind?: string | null;
  } | null;
  inject?: (message: AcpInjectMessage) => Promise<void> | void;
}

export interface AcpWorkerManagerLike {
  lookupSession: (chain_handoff_id: string) => AcpInjectableSessionLike | null | undefined | Promise<AcpInjectableSessionLike | null | undefined>;
}

function resolveAdapterId(session: AcpInjectableSessionLike): string {
  return (
    session.adapter
    ?? session.adapter_kind
    ?? session.metadata?.adapter
    ?? session.metadata?.adapter_kind
    ?? session.worker?.adapter
    ?? session.worker?.adapter_kind
    ?? ''
  );
}

export function supportsMidSessionInject(adapterId: string): boolean {
  return (
    adapterId === 'stdio-acp'
    || adapterId.startsWith('claude-acp')
    || adapterId.startsWith('codex-acp')
    || adapterId.startsWith('gemini-acp')
  );
}

export function createAcpInjector(opts: { workerManager: AcpWorkerManagerLike }): {
  inject(chain_handoff_id: string, message: AcpInjectMessage): Promise<void>;
} {
  return {
    async inject(chain_handoff_id: string, message: AcpInjectMessage): Promise<void> {
      let session: AcpInjectableSessionLike | null | undefined;
      try {
        session = await opts.workerManager.lookupSession(chain_handoff_id);
      } catch (error) {
        console.error(`[acp-injector] lookup failed for chain_handoff_id=${chain_handoff_id}`, error);
        return;
      }

      if (!session) {
        console.warn(`[acp-injector] no live session for chain_handoff_id=${chain_handoff_id}`);
        return;
      }

      const adapterId = resolveAdapterId(session);
      if (!supportsMidSessionInject(adapterId)) {
        console.warn(
          `[acp-injector] adapter does not support mid-session injection for chain_handoff_id=${chain_handoff_id} adapter=${adapterId || 'unknown'}`,
        );
        return;
      }

      if (typeof session.inject !== 'function') {
        console.warn(
          `[acp-injector] live session missing inject handler for chain_handoff_id=${chain_handoff_id} adapter=${adapterId || 'unknown'}`,
        );
        return;
      }

      try {
        await session.inject(message);
      } catch (error) {
        console.error(`[acp-injector] inject failed for chain_handoff_id=${chain_handoff_id}`, error);
      }
    },
  };
}
