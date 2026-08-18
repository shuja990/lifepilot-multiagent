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
import { runTool } from '../lib/http.js';
import { webSearch } from './search.js';
import {
  ProductsInputSchema,
  ProductsOutputSchema,
  type ProductsInput,
  type ProductsOutput,
  type ToolResult,
} from '@lifepilot/shared';

/**
 * Kept broad and international rather than US-only — the demo is run from
 * Pakistan and a US-only list returns unbuyable results.
 */
const RETAIL_DOMAINS = [
  'amazon.com',
  'ebay.com',
  'bestbuy.com',
  'walmart.com',
  'daraz.pk',
  'aliexpress.com',
  'newegg.com',
  'argos.co.uk',
];

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
      includeDomains: RETAIL_DOMAINS,
    });
    if (!result.ok) throw new Error(result.error);

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
