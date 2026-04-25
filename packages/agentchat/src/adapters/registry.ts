import type { Adapter } from '../sdk/adapter.js';
import { OpenAiCompatHttpAdapter, type OpenAiCompatHttpOptions } from './openai-compat-http.js';

export type AdapterFactory = (options: Record<string, unknown>) => Adapter;

const builtIns: Record<string, AdapterFactory> = {
  'openai-compat-http': (o) => {
    const opts = o as Partial<OpenAiCompatHttpOptions> & { api_key_env?: string };
    const apiKey = opts.apiKey ?? (opts.api_key_env ? process.env[opts.api_key_env] : undefined);
    if (!opts.baseUrl) throw new Error('openai-compat-http: baseUrl is required');
    if (!apiKey) throw new Error('openai-compat-http: apiKey or api_key_env is required');
    if (!opts.model) throw new Error('openai-compat-http: model is required');
    return new OpenAiCompatHttpAdapter({ baseUrl: opts.baseUrl, apiKey, model: opts.model, maxTokens: opts.maxTokens });
  },
};

export function buildAdapter(kind: string, options: Record<string, unknown>): Adapter {
  const factory = builtIns[kind];
  if (!factory) throw new Error(`unknown adapter kind: ${kind}`);
  return factory(options);
}

export function registerAdapter(kind: string, factory: AdapterFactory): void {
  builtIns[kind] = factory;
}
