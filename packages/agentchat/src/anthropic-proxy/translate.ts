export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock;

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicToolChoiceAuto {
  type: 'auto';
}
export interface AnthropicToolChoiceAny {
  type: 'any';
}
export interface AnthropicToolChoiceTool {
  type: 'tool';
  name: string;
}
export type AnthropicToolChoice =
  | AnthropicToolChoiceAuto
  | AnthropicToolChoiceAny
  | AnthropicToolChoiceTool;

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicTextBlock[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  stream?: boolean;
}

export interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  tools?: OpenAITool[];
  tool_choice?: string | { type: 'function'; function: { name: string } };
  stream?: boolean;
  chat_template_kwargs?: { enable_thinking: boolean };
}

export interface OpenAIChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason?: string;
}

export interface OpenAIResponse {
  id: string;
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

export interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: 'end_turn' | 'tool_use' | 'max_tokens';
  stop_sequence: null;
  usage: { input_tokens: number; output_tokens: number };
}

export function translateAnthropicToOpenAI(
  body: AnthropicRequest,
  options: { upstreamModel: string }
): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  if (body.system !== undefined) {
    const systemText =
      typeof body.system === 'string'
        ? body.system
        : body.system.map((b) => b.text).join('\n');
    messages.push({ role: 'system', content: systemText });
  }

  for (const msg of body.messages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
    } else {
      const textParts: string[] = [];
      const toolCalls: OpenAIToolCall[] = [];
      for (const block of msg.content) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        } else if (block.type === 'tool_result') {
          messages.push({
            role: 'tool',
            content: block.content,
            tool_call_id: block.tool_use_id,
          });
        }
      }
      if (textParts.length > 0) {
        messages.push({ role: msg.role, content: textParts.join('') });
      }
      if (toolCalls.length > 0) {
        messages.push({ role: msg.role, content: null, tool_calls: toolCalls });
      }
    }
  }

  const result: OpenAIRequest = {
    model: options.upstreamModel,
    messages,
    chat_template_kwargs: { enable_thinking: false },
  };

  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stream !== undefined) result.stream = body.stream;

  if (body.tools !== undefined) {
    result.tools = body.tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }));
  }

  if (body.tool_choice !== undefined) {
    if (body.tool_choice.type === 'auto') {
      result.tool_choice = 'auto';
    } else if (body.tool_choice.type === 'any') {
      result.tool_choice = 'required';
    } else if (body.tool_choice.type === 'tool') {
      result.tool_choice = {
        type: 'function',
        function: { name: body.tool_choice.name },
      };
    }
  }

  return result;
}

export function translateOpenAIToAnthropic(
  body: OpenAIResponse,
  options: { model: string }
): AnthropicResponse {
  const choice = body.choices[0];
  const msg = choice.message;
  const content: AnthropicContentBlock[] = [];

  if (msg.content) {
    content.push({ type: 'text', text: msg.content });
  }

  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      });
    }
  }

  let stop_reason: AnthropicResponse['stop_reason'] = 'end_turn';
  if (choice.finish_reason === 'tool_calls') {
    stop_reason = 'tool_use';
  } else if (choice.finish_reason === 'length') {
    stop_reason = 'max_tokens';
  }

  return {
    id: body.id,
    type: 'message',
    role: 'assistant',
    model: options.model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: body.usage?.prompt_tokens ?? 0,
      output_tokens: body.usage?.completion_tokens ?? 0,
    },
  };
}
