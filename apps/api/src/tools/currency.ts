/**
 * Currency conversion — ExchangeRate-API's open endpoint. No API key, no
 * signup, 160+ currencies, refreshed daily.
 *
 * PROVIDER NOTE (Phase 0 finding): the plan originally specified Frankfurter.
 * Frankfurter serves European Central Bank reference rates, which cover only
 * ~30 currencies and DO NOT include PKR — the home currency for this project's
 * demo. It returned a bare 404 for PKR, which would have surfaced as a broken
 * BudgetAgent much later. Swapped here; the tool surface is unchanged, which is
 * the whole point of keeping providers behind a thin adapter (docs/PLAN.md §8).
 *
 * Rates are daily reference rates, not the rate a traveller gets at a counter.
 * The BudgetAgent should present converted figures as approximate.
 */
import { fetchJson, runTool } from '../lib/http.js';
import {
  CurrencyInputSchema,
  CurrencyOutputSchema,
  type CurrencyInput,
  type CurrencyOutput,
  type ToolResult,
} from '@lifepilot/shared';

const BASE_URL = 'https://open.er-api.com/v6/latest';

interface ExchangeRateResponse {
  result: 'success' | 'error';
  'error-type'?: string;
  base_code?: string;
  time_last_update_utc?: string;
  rates?: Record<string, number>;
}

export async function convertCurrency(
  rawInput: CurrencyInput,
): Promise<ToolResult<CurrencyOutput>> {
  return runTool(async () => {
    const input = CurrencyInputSchema.parse(rawInput);
    const today = new Date().toISOString().slice(0, 10);

    // Same currency: no API call, and no chance of a spurious rate.
    if (input.from === input.to) {
      return CurrencyOutputSchema.parse({
        amount: input.amount,
        from: input.from,
        to: input.to,
        rate: 1,
        converted: input.amount,
        rateDate: today,
      });
    }

    const response = await fetchJson<ExchangeRateResponse>(`${BASE_URL}/${input.from}`);

    if (response.result !== 'success' || !response.rates) {
      throw new Error(
        `Exchange rates unavailable for base currency ${input.from}` +
          (response['error-type'] ? ` (${response['error-type']})` : ''),
      );
    }

    const rate = response.rates[input.to];
    if (typeof rate !== 'number') {
      throw new Error(`No exchange rate available for ${input.from} to ${input.to}.`);
    }

    return CurrencyOutputSchema.parse({
      amount: input.amount,
      from: input.from,
      to: input.to,
      rate,
      // Round to minor units; agents should never see 17 decimal places.
      converted: Math.round(input.amount * rate * 100) / 100,
      // Null rather than today's date: claiming a freshness we did not observe
      // is the same class of error as inventing a temperature.
      rateDate: parseRateDate(response.time_last_update_utc),
    });
  });
}

/** "Tue, 18 Aug 2026 00:02:31 +0000" -> "2026-08-18" */
function parseRateDate(raw: string | undefined): string | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}
