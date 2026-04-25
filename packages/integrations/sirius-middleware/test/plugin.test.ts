import { expect, test, describe } from 'bun:test';
import Fastify from 'fastify';
import { penumbraObservePlugin } from '../src/plugin.js';

describe('penumbraObservePlugin init', () => {
  test('logs compliant spec message when disabled', async () => {
    let logged = false;
    let loggedObj: any = null;
    const fastify = Fastify();
    await fastify.register(penumbraObservePlugin, {
      logger: { warn: () => {}, info: (obj: any) => {
        if (obj.msg === 'penumbra middleware disabled') {
            logged = true;
            loggedObj = obj;
        }
      }} as any,
    });
    expect(logged).toBe(true);
    expect(loggedObj).toBeDefined();
    expect(loggedObj.PENUMBRA_DAEMON_URL_present).toBe(false);
    expect(loggedObj.PENUMBRA_DAEMON_TOKEN_present).toBe(false);
  });
});
