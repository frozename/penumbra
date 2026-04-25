import { Module, Logger } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PENUMBRA_CONFIG, PENUMBRA_DAEMON_CLIENT } from './tokens.js';
import { loadConfig, type MiddlewareConfig } from './config.js';
import { PenumbraDaemonClient } from './daemon-client.js';
import { PenumbraDaemonNoopClient, type IPenumbraDaemonClient } from './client.js';
import { PenumbraObserveInterceptor } from './interceptor.js';

@Module({
  providers: [
    {
      provide: PENUMBRA_CONFIG,
      useFactory: (): MiddlewareConfig => {
        const cfg = loadConfig();
        const log = new Logger('PenumbraMiddlewareModule');
        if (cfg.kind === 'disabled') {
          log.warn({
            msg: 'penumbra middleware disabled — observations will not be emitted',
            reason: cfg.reason,
          });
        } else {
          log.log({
            msg: 'penumbra middleware enabled',
            baseUrl: cfg.baseUrl,
            machine_id: cfg.machineId,
          });
        }
        return cfg;
      },
    },
    {
      provide: PENUMBRA_DAEMON_CLIENT,
      inject: [PENUMBRA_CONFIG],
      useFactory: (cfg: MiddlewareConfig): IPenumbraDaemonClient => {
        if (cfg.kind !== 'enabled') return new PenumbraDaemonNoopClient();
        return new PenumbraDaemonClient({ baseUrl: cfg.baseUrl, token: cfg.token });
      },
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: PenumbraObserveInterceptor,
    },
  ],
})
export class PenumbraMiddlewareModule {}
