# @penumbra/sirius-middleware

This package provides a Fastify plugin that integrates a service with Penumbra for session observability and tracing. 

It acts as middleware that intercepts incoming requests and outgoing responses, logging them as observations to a running Penumbra Daemon.

## Features

- Automatically extracts correlation IDs (like `x-penumbra-session-id`) from incoming request headers to maintain session continuity.
- Extracts project identifiers from the `x-penumbra-project` header.
- Sends observations (T0 and T1) to the Penumbra Daemon.
- **Fail-Silent Semantics:** If the Penumbra Daemon is unreachable, or if an error occurs while recording observations, the middleware will catch the error and log a warning without disrupting the main request flow. The application remains fully functional.

## Installation

```bash
npm install @penumbra/sirius-middleware
```

## Configuration

The middleware requires the following environment variables to be set in order to communicate with the Penumbra Daemon:

- `PENUMBRA_DAEMON_URL`: The HTTP URL of the Penumbra Daemon (e.g., `http://127.0.0.1:42069`).
- `PENUMBRA_DAEMON_TOKEN`: The authentication token required to send observations to the daemon.

## Usage

Register the plugin with your Fastify instance:

```typescript
import Fastify from 'fastify';
import { penumbraFastifyPlugin } from '@penumbra/sirius-middleware';

const app = Fastify({ logger: true });

// Register the middleware
app.register(penumbraFastifyPlugin);

app.get('/', async (request, reply) => {
  return { hello: 'world' };
});

const start = async () => {
  try {
    await app.listen({ port: 3000 });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
```

## Headers Contract

The plugin expects the following custom headers (typically forwarded by clients or an API Gateway):

- `x-penumbra-project` (Required for observation routing): Specifies the project name the observation belongs to.
- `x-penumbra-session-id` (Optional): Specifies the session ID. If provided, the observation is tied to this session.

If the `x-penumbra-project` header is missing, the middleware will skip recording observations for that specific request.
