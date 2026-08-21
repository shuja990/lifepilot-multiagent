/**
 * Product search — retail-scoped web search.
 *
 * There is no good free structured product API (see docs/PLAN.md §3.3), so
 * this is retrieval scoped to retail domains. Structured price extraction is
 * deliberately NOT done here: no LLM runs inside the tool layer, so
 * `priceApprox` stays null and nothing in the output is ever invented. The
 * PriceResearch agent extracts prices in a later phase, against the shared
 * ProductCandidate schema, where a wrong number is at least attributable.
 */
import { ToolFailure, runTool } from '../lib/http.js';
import { optionalEnv } from '../config/env.js';
import { webSearch } from './search.js';
import {
  ProductsInputSchema,
  ProductsOutputSchema,
  type ProductsInput,
  type ProductsOutput,
  type ToolResult,
} from '@lifepilot/shared';

/**
 * Spread across regions on purpose.
 *
 * A US-only list returns results most of the world cannot actually buy, and a
 * single-market list quietly makes the whole product a single-market product.
 * Override RETAIL_DOMAINS to bias toward one market.
 */
const DEFAULT_RETAIL_DOMAINS = [
  'amazon.com',
  'amazon.co.uk',
  'amazon.de',
  'ebay.com',
  'bestbuy.com',
  'walmart.com',
  'aliexpress.com',
  'newegg.com',
  'argos.co.uk',
  'mediamarkt.de',
];

const RETAIL_DOMAINS = (optionalEnv('RETAIL_DOMAINS') || '')
  .split(',')
  .map((domain) => domain.trim())
  .filter(Boolean);

const DATA_NOTES =
  'Retrieval only: these are retail search results, not a structured product ' +
  'feed. Prices are NOT extracted here and must not be inferred from titles. ' +
  'Availability and pricing require opening the listing.';

export async function findProducts(
  rawInput: ProductsInput,
): Promise<ToolResult<ProductsOutput>> {
  return runTool(async () => {
    const input = ProductsInputSchema.parse(rawInput);

    const result = await webSearch({
      query: `${input.query} price buy`,
      maxResults: input.maxResults,
      depth: 'basic',
      includeDomains: RETAIL_DOMAINS.length > 0 ? RETAIL_DOMAINS : DEFAULT_RETAIL_DOMAINS,
    });
    // Preserve missingEnv/retryable so `products` reports a missing TAVILY_API_KEY
    // with the same actionable hint that `search` does.
    if (!result.ok) throw new ToolFailure(result);

    const candidates = result.data.hits.map((hit) => ({
      title: hit.title,
      url: hit.url,
      snippet: hit.snippet,
      source: safeHost(hit.url),
      priceApprox: null,
      currency: null,
    }));

    return ProductsOutputSchema.parse({
      query: input.query,
      candidates,
      dataNotes: DATA_NOTES,
    });
  });
}

function safeHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}
