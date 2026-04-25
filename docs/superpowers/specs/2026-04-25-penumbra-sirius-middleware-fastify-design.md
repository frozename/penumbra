# Penumbra Sirius Middleware - Fastify Plugin Design

This document details the transition from the V1 NestJS `PenumbraObserveInterceptor` to a pure Fastify Plugin architecture for the `@penumbra/sirius-middleware` integration. This change addresses the core architectural gap where NestJS `APP_INTERCEPTOR` fails to capture response bodies when controllers use `@Res() FastifyReply`.

## Architecture & Integration

We replace `PenumbraMiddlewareModule` and `PenumbraObserveInterceptor` with a standard Fastify plugin (`penumbraObservePlugin`). The plugin relies strictly on Fastify's native lifecycle hooks, bypassing NestJS's execution context and interceptor pipeline entirely.

*   **Request Capture (`preHandler`):** Intercepts `POST /v1/chat/completions`. If the `x-penumbra-project` header is present, the plugin extracts the request body, mints a `session_id`, and fires the `agent-prompt` observation to the Penumbra daemon.
*   **Response Capture (`onSend`):** Hooks into `onSend` for the same requests. Fastify's `onSend` hook reliably receives the final serialized response body (or stream) regardless of how the controller built it (e.g., using `@Res()` or returning objects). We parse this payload to extract token usage and the model, and fire the `agent-response` observation.
*   **Integration (`sirius-gateway`):** Instead of importing a module in `app.module.ts`, `sirius-gateway` will register the plugin directly on the Fastify adapter in `main.ts`:
    ```typescript
    import { penumbraObservePlugin } from '@penumbra/sirius-middleware';

    const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
    await app.register(penumbraObservePlugin, {
      baseUrl: process.env.PENUMBRA_DAEMON_URL,
      token: process.env.PENUMBRA_DAEMON_TOKEN,
      machineId: await services.machineId.get()
    });
    ```

## Payload Capture & Edge Cases

*   **Non-Streamed (`onSend` String Payload):** The `onSend` hook intercepts the serialized string response. We `JSON.parse()` the string payload (the OpenAI chat completion response format) to extract `model`, `choices[0].message.content` (for `payload_summary`), and `usage`. We emit the `agent-response` event as a background fire-and-forget task and return the original string payload unmodified.
*   **Streamed (`onSend` Stream Payload):** If `payload` is a `ReadableStream` (e.g., SSE), Fastify allows `onSend` hooks to tee or wrap the stream. We attach an `on('data')` listener to accumulate the text events, and an `on('end')` listener to fire the `agent-response` observation once the stream finishes.
*   **Error Handling (Daemon Failures):** The plugin remains fail-silent. If the POST to Penumbra's `v1/observations` fails (network error, timeout, or 500 status), we log a warning with the `project_id`, `request_id`, `session_id`, and `error` but never bubble the exception to Fastify. The user's response from `sirius-gateway` remains completely unaffected.

## Observability, Typing, & Integration Details

*   **Type Safety:** We define an `IPenumbraDaemonClient` interface (exporting only `observe(event: T0EventInput)`) for the NOOP fallback.
*   **Drop Rate Observability:** To handle dropped observations, we introduce a `dropped_observations` metric/counter. If a POST fails, we increment this counter and log a `warn` struct matching spec §5: `{ msg, project_id, request_id, route, error }`.
*   **Init Logs:** On plugin registration, if disabled, we log `{ msg, PENUMBRA_DAEMON_URL_present, PENUMBRA_DAEMON_TOKEN_present }` to strictly comply with Spec §5.
*   **SSE Final Flush:** When the stream ends (`on('end')`), we ensure any remaining buffer is flushed and parsed before firing the `agent-response`.
*   **Test Gap (`spec §6 case 8`):** We augment our tests with a case where the daemon rejects the `agent-prompt` but succeeds on `agent-response` to verify independent resilience.
*   **Documentation:** The integration includes a `README.md` detailing the plugin semantics, required env vars, and the `x-penumbra-project` contract. We also add the operational runbook line to `AGENTS.md` in `sirius-gateway`.
