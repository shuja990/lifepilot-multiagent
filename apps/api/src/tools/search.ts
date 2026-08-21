/**
 * Web search — Tavily. Free tier is 1,000 credits/month with no credit card,
 * which is the most generous of the current options (Brave removed its free
 * tier in Feb 2026). See docs/ARCHITECTURE.md.
 *
 * Credit discipline matters here: a 'basic' search costs 1 credit and an
 * 'advanced' one costs 2. With a ParallelAgent fan-out it is easy to spend a
 * month of quota in an afternoon, so the default stays 'basic' and the depth
 * is an explicit, deliberate choice by the caller.
 */
import { fetchJson, runTool } from '../lib/http.js';
import { requireEnv } from '../config/env.js';
import {
  SearchInputSchema,
  SearchOutputSchema,
  type SearchInput,
  type SearchOutput,
  type ToolResult,
} from '@lifepilot/shared';

const SEARCH_URL = 'https://api.tavily.com/search';

interface TavilyResponse {
  query: string;
  answer?: string | null;
  results?: Array<{
    title: string;
    url: string;
    content: string;
    score?: number;
  }>;
}

export async function webSearch(rawInput: SearchInput): Promise<ToolResult<SearchOutput>> {
  return runTool(async () => {
    const input = SearchInputSchema.parse(rawInput);
    const apiKey = requireEnv('TAVILY_API_KEY');

    const response = await fetchJson<TavilyResponse>(SEARCH_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: {
        query: input.query,
        max_results: input.maxResults,
        search_depth: input.depth,
        include_answer: true,
        ...(input.includeDomains.length > 0 ? { include_domains: input.includeDomains } : {}),
      },
      // Search is the slowest tool in the set; give it more room than the default.
      timeoutMs: 20_000,
    });

    return SearchOutputSchema.parse({
      query: response.query ?? input.query,
      answer: response.answer ?? null,
      hits: (response.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        score: typeof r.score === 'number' ? r.score : null,
      })),
    });
  });
}
