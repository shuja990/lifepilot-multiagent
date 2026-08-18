/**
 * An OpenAI-compatible provider for ADK.
 *
 * ADK for TypeScript ships model implementations for Gemini and Apigee only,
 * and LiteLLM — the escape hatch the Python SDK uses — has no TS equivalent.
 * So multi-provider support means implementing BaseLlm directly.
 *
 * The payoff is that Groq, DeepSeek, OpenRouter, Ollama, vLLM and Azure all
 * speak the same chat-completions dialect, so ONE adapter covers all of them;
 * only the base URL and the key change.
 *
 * The hard part is not the HTTP call, it is the translation. ADK speaks
 * @google/genai `Content` — roles 'user'/'model', parts carrying functionCall
 * and functionResponse. OpenAI speaks messages with roles
 * 'system'/'user'/'assistant'/'tool', tool calls as a separate array, and tool
 * results as their own message keyed by tool_call_id. Everything below is that
 * mapping, in both directions.
 */
import { BaseLlm } from '@google/adk';
import type { BaseLlmConnection, LlmRequest, LlmResponse } from '@google/adk';
import type { Content, FunctionDeclaration, Part } from '@google/genai';
import { optionalEnv } from '../config/env.js';

/* --------------------------------------------------------------- providers */

export interface ProviderConfig {
  baseUrl: string;
  /** Env var holding the key. Read lazily so an unset provider is inert. */
  apiKeyEnv: string;
}

/**
 * Prefix -> endpoint. The prefix is stripped before the model id is sent, so
 * `groq/llama-3.3-70b-versatile` reaches Groq as `llama-3.3-70b-versatile`.
 */
export const PROVIDERS: Record<string, ProviderConfig> = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY' },
};

/* ------------------------------------------------------- OpenAI wire types */

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIChoice {
  index: number;
  message?: { role: string; content?: string | null; tool_calls?: OpenAIToolCall[] };
  delta?: { content?: string | null; tool_calls?: Array<Partial<OpenAIToolCall> & { index: number }> };
  finish_reason?: string | null;
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: { message?: string; code?: string | number; type?: string };
}

/* ------------------------------------------------------------- the adapter */

export class OpenAICompatibleLlm extends BaseLlm {
  /**
   * Matched by LlmRegistry. Any model id prefixed with a known provider is
   * handled here, so adding a provider is one entry in PROVIDERS.
   */
  static override readonly supportedModels: Array<string | RegExp> = [
    /^groq\/.+$/,
    /^deepseek\/.+$/,
    /^openrouter\/.+$/,
  ];

  private readonly provider: ProviderConfig;
  private readonly providerName: string;
  private readonly upstreamModel: string;

  constructor({ model }: { model: string }) {
    super({ model });

    const slash = model.indexOf('/');
    const prefix = slash === -1 ? '' : model.slice(0, slash);
    const config = PROVIDERS[prefix];
    if (!config) {
      throw new Error(
        `Unknown provider prefix in model "${model}". ` +
          `Expected one of: ${Object.keys(PROVIDERS).join(', ')} (e.g. "groq/llama-3.3-70b-versatile").`,
      );
    }

    this.providerName = prefix;
    this.provider = config;
    // OpenRouter model ids contain their own slash (openrouter/anthropic/claude-…),
    // so strip only the first segment.
    this.upstreamModel = model.slice(slash + 1);
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    stream = false,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    const apiKey = optionalEnv(this.provider.apiKeyEnv);
    if (!apiKey) {
      // Surfaced as a response rather than thrown: a missing optional provider
      // should degrade the run, not crash it, and RoutedLlm can fail over.
      yield {
        errorCode: 'MISSING_API_KEY',
        errorMessage: `${this.provider.apiKeyEnv} is not set, so model "${this.model}" cannot be used.`,
      };
      return;
    }

    const body = {
      model: this.upstreamModel,
      messages: this.toOpenAIMessages(llmRequest),
      ...this.toOpenAITools(llmRequest),
      ...(llmRequest.config?.temperature !== undefined
        ? { temperature: llmRequest.config.temperature }
        : {}),
      ...(llmRequest.config?.maxOutputTokens !== undefined
        ? { max_tokens: llmRequest.config.maxOutputTokens }
        : {}),
      stream,
    };

    const response = await fetch(`${this.provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        // OpenRouter asks for attribution headers; harmless elsewhere.
        'http-referer': 'https://github.com/shuja990/lifepilot-multiagent',
        'x-title': 'LifePilot',
      },
      body: JSON.stringify(body),
      ...(abortSignal ? { signal: abortSignal } : {}),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      yield {
        errorCode: String(response.status),
        errorMessage: `${this.providerName} returned HTTP ${response.status}${
          detail ? `: ${detail.slice(0, 400)}` : ''
        }`,
      };
      return;
    }

    if (stream) {
      yield* this.readStream(response);
      return;
    }

    const json = (await response.json()) as OpenAIResponse;
    if (json.error) {
      yield { errorCode: String(json.error.code ?? 'error'), errorMessage: json.error.message };
      return;
    }

    const choice = json.choices?.[0];
    yield {
      content: this.toGenaiContent(choice?.message?.content, choice?.message?.tool_calls),
      turnComplete: true,
      ...(json.usage
        ? {
            usageMetadata: {
              promptTokenCount: json.usage.prompt_tokens,
              candidatesTokenCount: json.usage.completion_tokens,
              totalTokenCount: json.usage.total_tokens,
            },
          }
        : {}),
    };
  }

  override connect(): Promise<BaseLlmConnection> {
    // Bidi streaming is a Gemini Live feature with no chat-completions analogue.
    return Promise.reject(
      new Error(`Live connections are not supported by ${this.providerName}; use Gemini for live mode.`),
    );
  }

  /* ------------------------------------------------------- ADK -> OpenAI */

  private toOpenAIMessages(llmRequest: LlmRequest): OpenAIMessage[] {
    const messages: OpenAIMessage[] = [];

    const system = llmRequest.config?.systemInstruction;
    if (system) {
      const text = typeof system === 'string' ? system : contentToText(system as Content);
      if (text) messages.push({ role: 'system', content: text });
    }

    for (const content of llmRequest.contents ?? []) {
      messages.push(...this.contentToMessages(content));
    }

    return messages;
  }

  /**
   * One genai Content can become several OpenAI messages: a model turn holding
   * both text and two function calls is one assistant message, while each
   * functionResponse must become its own `tool` message.
   */
  private contentToMessages(content: Content): OpenAIMessage[] {
    const parts = content.parts ?? [];
    const messages: OpenAIMessage[] = [];

    const toolResponses = parts.filter((p) => p.functionResponse);
    const functionCalls = parts.filter((p) => p.functionCall);
    const text = parts
      .map((p) => p.text ?? '')
      .join('')
      .trim();

    // Tool results are their own role and must reference the call they answer.
    for (const part of toolResponses) {
      const fr = part.functionResponse!;
      messages.push({
        role: 'tool',
        tool_call_id: fr.id ?? syntheticId(fr.name ?? 'tool'),
        content: JSON.stringify(fr.response ?? {}),
      });
    }

    if (functionCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls: functionCalls.map((part) => {
          const fc = part.functionCall!;
          return {
            id: fc.id ?? syntheticId(fc.name ?? 'tool'),
            type: 'function' as const,
            // OpenAI wants arguments as a JSON *string*; genai gives an object.
            function: { name: fc.name ?? '', arguments: JSON.stringify(fc.args ?? {}) },
          };
        }),
      });
      return messages;
    }

    if (text) {
      messages.push({ role: content.role === 'model' ? 'assistant' : 'user', content: text });
    }

    return messages;
  }

  private toOpenAITools(llmRequest: LlmRequest): Record<string, unknown> {
    const declarations: FunctionDeclaration[] = (llmRequest.config?.tools ?? []).flatMap(
      (tool) => (tool as { functionDeclarations?: FunctionDeclaration[] }).functionDeclarations ?? [],
    );
    if (declarations.length === 0) return {};

    return {
      tools: declarations.map((declaration) => ({
        type: 'function',
        function: {
          name: declaration.name,
          description: declaration.description,
          // Gemini omits `parameters` for no-arg tools; OpenAI wants an object.
          parameters: geminiSchemaToJsonSchema(declaration.parameters) ?? {
            type: 'object',
            properties: {},
          },
        },
      })),
      tool_choice: 'auto',
    };
  }

  /* ------------------------------------------------------- OpenAI -> ADK */

  private toGenaiContent(
    text: string | null | undefined,
    toolCalls: OpenAIToolCall[] | undefined,
  ): Content {
    const parts: Part[] = [];

    if (text) parts.push({ text });

    for (const call of toolCalls ?? []) {
      parts.push({
        functionCall: {
          id: call.id,
          name: call.function.name,
          // Providers occasionally emit malformed JSON here. Surfacing the raw
          // string beats throwing: the model can see its own mistake and retry.
          args: safeParseArgs(call.function.arguments),
        },
      });
    }

    return { role: 'model', parts };
  }

  /**
   * Reassembles a chat-completions SSE stream.
   *
   * Tool calls arrive as fragments indexed by position, with `name` on the
   * first fragment and `arguments` split across later ones, so they must be
   * accumulated before the call can be emitted. Text is yielded as it arrives
   * so the UI stays live; the final response carries the assembled tool calls.
   */
  private async *readStream(response: Response): AsyncGenerator<LlmResponse, void> {
    const reader = response.body?.getReader();
    if (!reader) {
      yield { errorCode: 'NO_BODY', errorMessage: 'Streaming response had no body.' };
      return;
    }

    const decoder = new TextDecoder();
    const pending: Array<{ id?: string; name?: string; args: string }> = [];
    let buffer = '';
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      // Keep the trailing fragment: an SSE line can be split across chunks.
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;

        let parsed: OpenAIResponse;
        try {
          parsed = JSON.parse(payload) as OpenAIResponse;
        } catch {
          continue; // keep-alive or partial frame
        }

        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          fullText += delta.content;
          yield { content: { role: 'model', parts: [{ text: delta.content }] }, partial: true };
        }

        for (const fragment of delta.tool_calls ?? []) {
          const slot = (pending[fragment.index] ??= { args: '' });
          if (fragment.id) slot.id = fragment.id;
          if (fragment.function?.name) slot.name = fragment.function.name;
          if (fragment.function?.arguments) slot.args += fragment.function.arguments;
        }
      }
    }

    const assembled: OpenAIToolCall[] = pending
      .filter((slot) => slot?.name)
      .map((slot) => ({
        id: slot.id ?? syntheticId(slot.name ?? 'tool'),
        type: 'function' as const,
        function: { name: slot.name ?? '', arguments: slot.args },
      }));

    yield {
      content: this.toGenaiContent(assembled.length > 0 ? null : fullText, assembled),
      turnComplete: true,
    };
  }
}

/* ---------------------------------------------------- schema translation */

/** Gemini's OpenAPI-flavoured type names -> JSON Schema type names. */
const TYPE_NAMES: Record<string, string> = {
  OBJECT: 'object',
  STRING: 'string',
  NUMBER: 'number',
  INTEGER: 'integer',
  BOOLEAN: 'boolean',
  ARRAY: 'array',
};

/** Keywords JSON Schema requires to be numeric, which Gemini may emit as strings. */
const NUMERIC_KEYWORDS = new Set([
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'minProperties',
  'maxProperties',
]);

/**
 * Converts a Gemini function-declaration schema into strict JSON Schema.
 *
 * ADK derives declarations in Gemini's dialect, which differs from JSON Schema
 * in two ways that strict validators reject outright:
 *
 *   1. Types are upper-case enum names — `"OBJECT"`, `"STRING"` — where JSON
 *      Schema wants `"object"`, `"string"`.
 *   2. Numeric constraints are serialised as STRINGS: `"minLength": "2"`.
 *
 * Gemini itself accepts both, so this only shows up on a third-party provider.
 * Groq rejected the entire request with a JSON-Schema compilation error that
 * pointed at `/properties/location/type` and named no tool — the sort of error
 * that costs an afternoon if you have not seen it before.
 *
 * This is the single most important function in the adapter: without it,
 * multi-provider support silently means "text only, no tools".
 */
export function geminiSchemaToJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object') return undefined;

  const convert = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(convert);
    if (!node || typeof node !== 'object') return node;

    const output: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'type' && typeof value === 'string') {
        const mapped = TYPE_NAMES[value.toUpperCase()];
        // TYPE_UNSPECIFIED and anything unrecognised is dropped rather than
        // passed through as an invalid type.
        if (mapped) output['type'] = mapped;
        continue;
      }

      if (NUMERIC_KEYWORDS.has(key)) {
        const asNumber = typeof value === 'string' ? Number(value) : value;
        if (typeof asNumber === 'number' && Number.isFinite(asNumber)) output[key] = asNumber;
        continue;
      }

      // Gemini expresses nullability with its own flag; JSON Schema uses a
      // type union, so fold it in and drop the non-standard keyword.
      if (key === 'nullable') continue;

      output[key] = convert(value);
    }

    if ((node as Record<string, unknown>)['nullable'] === true && typeof output['type'] === 'string') {
      output['type'] = [output['type'], 'null'];
    }

    return output;
  };

  return convert(schema) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ utils */

function contentToText(content: Content): string {
  return (content.parts ?? []).map((p) => p.text ?? '').join('');
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { __unparsed_arguments: raw };
  }
}

let idCounter = 0;
/** Stable-enough id for providers that omit one; only needs per-request uniqueness. */
function syntheticId(name: string): string {
  idCounter += 1;
  return `${name}_${idCounter}`;
}
