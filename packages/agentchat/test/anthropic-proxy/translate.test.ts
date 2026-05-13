import { expect, test } from 'bun:test';
import {
  translateAnthropicToOpenAI,
  translateOpenAIToAnthropic,
} from '../../src/anthropic-proxy/translate.js';

test('request: simple system + user message → OpenAI with system prepended', () => {
  const out = translateAnthropicToOpenAI(
    {
      model: 'claude-3-opus-20240229',
      system: 'Be helpful',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1024,
    },
    { upstreamModel: 'gemma4-26b-a4b-mtp' }
  );
  expect(out.model).toBe('gemma4-26b-a4b-mtp');
  expect(out.messages).toEqual([
    { role: 'system', content: 'Be helpful' },
    { role: 'user', content: 'hi' },
  ]);
  expect(out.max_tokens).toBe(1024);
  expect(out.chat_template_kwargs).toEqual({ enable_thinking: false });
});

test('request: Anthropic tool definition → OpenAI tool definition shape', () => {
  const out = translateAnthropicToOpenAI(
    {
      model: 'claude-3-opus-20240229',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'get_weather',
          description: 'Get the weather',
          input_schema: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
      max_tokens: 1024,
    },
    { upstreamModel: 'gemma4-26b-a4b-mtp' }
  );
  expect(out.tools).toEqual([
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get the weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    },
  ]);
});

test('request: assistant message with tool_use block → OpenAI assistant message with tool_calls', () => {
  const out = translateAnthropicToOpenAI(
    {
      model: 'claude-3-opus-20240229',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } },
          ],
        },
      ],
      max_tokens: 1024,
    },
    { upstreamModel: 'gemma4-26b-a4b-mtp' }
  );
  expect(out.messages).toEqual([
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'tu_1',
          type: 'function',
          function: { name: 'get_weather', arguments: JSON.stringify({ city: 'Paris' }) },
        },
      ],
    },
  ]);
});

test('request: user message with tool_result block → OpenAI tool role message', () => {
  const out = translateAnthropicToOpenAI(
    {
      model: 'claude-3-opus-20240229',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'Sunny, 22C' },
          ],
        },
      ],
      max_tokens: 1024,
    },
    { upstreamModel: 'gemma4-26b-a4b-mtp' }
  );
  expect(out.messages).toEqual([
    { role: 'tool', tool_call_id: 'tu_1', content: 'Sunny, 22C' },
  ]);
});

test('response (non-streaming): OpenAI text-only → Anthropic envelope with stop_reason end_turn', () => {
  const out = translateOpenAIToAnthropic(
    {
      id: 'chatcmpl-123',
      choices: [
        {
          message: { role: 'assistant', content: 'Hello there' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    },
    { model: 'claude-3-opus-20240229' }
  );
  expect(out).toEqual({
    id: 'chatcmpl-123',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-opus-20240229',
    content: [{ type: 'text', text: 'Hello there' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 2 },
  });
});

test('response (non-streaming): OpenAI tool_calls → Anthropic content tool_use blocks, stop_reason tool_use', () => {
  const out = translateOpenAIToAnthropic(
    {
      id: 'chatcmpl-456',
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 8 },
    },
    { model: 'claude-3-opus-20240229' }
  );
  expect(out).toEqual({
    id: 'chatcmpl-456',
    type: 'message',
    role: 'assistant',
    model: 'claude-3-opus-20240229',
    content: [
      { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Paris' } },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 8 },
  });
});

test('stop-reason mapping: stop → end_turn, length → max_tokens, tool_calls → tool_use', () => {
  expect(
    translateOpenAIToAnthropic(
      { choices: [{ message: { role: 'assistant', content: 'a' }, finish_reason: 'stop' }] },
      { model: 'm' }
    ).stop_reason
  ).toBe('end_turn');
  expect(
    translateOpenAIToAnthropic(
      { choices: [{ message: { role: 'assistant', content: 'a' }, finish_reason: 'length' }] },
      { model: 'm' }
    ).stop_reason
  ).toBe('max_tokens');
  expect(
    translateOpenAIToAnthropic(
      {
        choices: [
          {
            message: { role: 'assistant', content: null, tool_calls: [] },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { model: 'm' }
    ).stop_reason
  ).toBe('tool_use');
});

test('request: tool_choice translations', () => {
  expect(
    translateAnthropicToOpenAI(
      { model: 'c', messages: [], tool_choice: { type: 'auto' } },
      { upstreamModel: 'm' }
    ).tool_choice
  ).toBe('auto');
  expect(
    translateAnthropicToOpenAI(
      { model: 'c', messages: [], tool_choice: { type: 'any' } },
      { upstreamModel: 'm' }
    ).tool_choice
  ).toBe('required');
  expect(
    translateAnthropicToOpenAI(
      { model: 'c', messages: [], tool_choice: { type: 'tool', name: 'get_weather' } },
      { upstreamModel: 'm' }
    ).tool_choice
  ).toEqual({ type: 'function', function: { name: 'get_weather' } });
});

test('request: temperature and top_p pass through', () => {
  const out = translateAnthropicToOpenAI(
    { model: 'c', messages: [], temperature: 0.5, top_p: 0.9 },
    { upstreamModel: 'm' }
  );
  expect(out.temperature).toBe(0.5);
  expect(out.top_p).toBe(0.9);
});

test('request: system array → concatenated system message', () => {
  const out = translateAnthropicToOpenAI(
    {
      model: 'c',
      system: [
        { type: 'text', text: 'Be helpful' },
        { type: 'text', text: 'Be concise' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    },
    { upstreamModel: 'm' }
  );
  expect(out.messages[0]).toEqual({ role: 'system', content: 'Be helpful\nBe concise' });
});

test('request: user content array with text blocks → concatenated string', () => {
  const out = translateAnthropicToOpenAI(
    {
      model: 'c',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }],
        },
      ],
    },
    { upstreamModel: 'm' }
  );
  expect(out.messages).toEqual([{ role: 'user', content: 'Hello world' }]);
});

test('request: no system field → no system message prepended', () => {
  const out = translateAnthropicToOpenAI(
    { model: 'c', messages: [{ role: 'user', content: 'hi' }] },
    { upstreamModel: 'm' }
  );
  expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
});

test('request: stream true is passed through', () => {
  const out = translateAnthropicToOpenAI(
    { model: 'c', messages: [], stream: true },
    { upstreamModel: 'm' }
  );
  expect(out.stream).toBe(true);
});
