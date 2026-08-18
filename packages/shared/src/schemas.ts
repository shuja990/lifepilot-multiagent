/**
 * The contract layer.
 *
 * Every tool's input and output is declared here exactly once. These schemas
 * are consumed by:
 *   - the API, to derive ADK function declarations and validate tool results
 *   - the web app, to render forms (incl. the approval modal) and type responses
 *
 * If a shape is needed on both sides, it belongs in this file. If it is only
 * ever internal to one app, it does not.
 */
import { z } from 'zod';

/* ------------------------------------------------------------------ common */

export const CoordinatesSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export type Coordinates = z.infer<typeof CoordinatesSchema>;

/** ISO-4217, e.g. "PKR". Uppercased on parse so callers can be sloppy. */
export const CurrencyCodeSchema = z
  .string()
  .trim()
  .length(3)
  .transform((c) => c.toUpperCase());

/** ISO-8601 calendar date, e.g. "2026-08-18". */
export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/**
 * The envelope every tool returns.
 *
 * Tools never throw across the agent boundary: an LLM handles
 * `{ ok: false, error }` far better than an exception, and it keeps one failed
 * tool from killing an entire ParallelAgent branch.
 */
export const ToolErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  /** Set when the failure is a missing API key, so the CLI can name it. */
  missingEnv: z.string().optional(),
  /** True when retrying later might work (rate limit, timeout, 5xx). */
  retryable: z.boolean().default(false),
});
export type ToolError = z.infer<typeof ToolErrorSchema>;

export type ToolResult<T> = { ok: true; data: T } | ToolError;

/* ----------------------------------------------------------------- weather */

export const WeatherInputSchema = z.object({
  location: z.string().min(2).describe('City or place name, e.g. "Islamabad"'),
  days: z.number().int().min(1).max(16).default(3).describe('Forecast days, 1-16'),
});
export type WeatherInput = z.input<typeof WeatherInputSchema>;

export const WeatherDaySchema = z.object({
  date: IsoDateSchema,
  /**
   * Nullable on purpose. Open-Meteo returns null for days at the far edge of
   * the forecast window, and substituting a number there would hand an agent a
   * plausible-looking temperature that nothing downstream could detect as fake.
   */
  tempMinC: z.number().nullable(),
  tempMaxC: z.number().nullable(),
  precipitationChancePct: z.number().min(0).max(100).nullable(),
  summary: z.string().describe('Human-readable condition, e.g. "Partly cloudy"'),
});
export type WeatherDay = z.infer<typeof WeatherDaySchema>;

export const WeatherOutputSchema = z.object({
  resolvedLocation: z.string(),
  coordinates: CoordinatesSchema,
  timezone: z.string(),
  days: z.array(WeatherDaySchema),
});
export type WeatherOutput = z.infer<typeof WeatherOutputSchema>;

/* ---------------------------------------------------------------- currency */

export const CurrencyInputSchema = z.object({
  // .min(0), not .positive(): `positive()` serialises to `exclusiveMinimum`,
  // which the Gemini function-declaration schema rejects outright with a 400.
  // See assertGeminiCompatible() — a test holds every tool schema to that subset.
  amount: z.number().min(0).default(1),
  from: CurrencyCodeSchema,
  to: CurrencyCodeSchema,
});
export type CurrencyInput = z.input<typeof CurrencyInputSchema>;

export const CurrencyOutputSchema = z.object({
  amount: z.number(),
  from: z.string(),
  to: z.string(),
  rate: z.number(),
  converted: z.number(),
  /**
   * Publication date of the rate. Null when the provider did not report one —
   * never silently backfilled with today, which would overstate freshness.
   */
  rateDate: IsoDateSchema.nullable(),
});
export type CurrencyOutput = z.infer<typeof CurrencyOutputSchema>;

/* ------------------------------------------------------------------ places */

/**
 * A small closed set, deliberately not raw provider category strings. The LLM
 * picks from these and places.ts maps them onto the provider taxonomy. That
 * mapping is the only thing that changes if Geoapify is ever swapped out.
 */
export const PlaceCategorySchema = z.enum([
  'restaurant',
  'cafe',
  'hotel',
  'attraction',
  'museum',
  'park',
  'shopping',
  'pharmacy',
  'hospital',
  'airport',
  'train_station',
  'atm',
]);
export type PlaceCategory = z.infer<typeof PlaceCategorySchema>;

export const PlacesInputSchema = z.object({
  near: z.string().min(2).describe('Place name or address to search around'),
  category: PlaceCategorySchema,
  radiusMeters: z.number().int().min(100).max(50_000).default(5_000),
  limit: z.number().int().min(1).max(20).default(8),
});
export type PlacesInput = z.input<typeof PlacesInputSchema>;

export const PlaceSchema = z.object({
  name: z.string(),
  address: z.string().nullable(),
  coordinates: CoordinatesSchema,
  distanceMeters: z.number().nullable(),
  categories: z.array(z.string()),
  website: z.string().nullable(),
  phone: z.string().nullable(),
  openingHours: z.string().nullable(),
});
export type Place = z.infer<typeof PlaceSchema>;

export const PlacesOutputSchema = z.object({
  resolvedLocation: z.string(),
  center: CoordinatesSchema,
  places: z.array(PlaceSchema),
  /**
   * Surfaced so agents and the UI never imply a ranking the data cannot
   * support: OpenStreetMap has no ratings, reviews, or photos.
   */
  dataNotes: z.string(),
});
export type PlacesOutput = z.infer<typeof PlacesOutputSchema>;

/* --------------------------------------------------------------- geocoding */

export const GeocodeInputSchema = z.object({
  query: z.string().min(2).describe('Address or place name'),
});
export type GeocodeInput = z.input<typeof GeocodeInputSchema>;

export const GeocodeOutputSchema = z.object({
  formatted: z.string(),
  coordinates: CoordinatesSchema,
  country: z.string().nullable(),
  city: z.string().nullable(),
});
export type GeocodeOutput = z.infer<typeof GeocodeOutputSchema>;

/* ------------------------------------------------------------------ search */

export const SearchInputSchema = z.object({
  query: z.string().min(3),
  maxResults: z.number().int().min(1).max(10).default(5),
  /** 'advanced' costs 2 Tavily credits instead of 1; use it sparingly. */
  depth: z.enum(['basic', 'advanced']).default('basic'),
  includeDomains: z.array(z.string()).default([]),
});
export type SearchInput = z.input<typeof SearchInputSchema>;

export const SearchHitSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  score: z.number().nullable(),
});
export type SearchHit = z.infer<typeof SearchHitSchema>;

export const SearchOutputSchema = z.object({
  query: z.string(),
  answer: z.string().nullable().describe('Provider-generated summary, when available'),
  hits: z.array(SearchHitSchema),
});
export type SearchOutput = z.infer<typeof SearchOutputSchema>;

/* ---------------------------------------------------------------- products */

export const ProductsInputSchema = z.object({
  query: z.string().min(2).describe('What to buy, e.g. "noise cancelling headphones"'),
  maxResults: z.number().int().min(1).max(10).default(5),
  // No `currency` field: this tool cannot honour one. Advertising a parameter
  // we ignore would let an agent pass currency:'PKR', receive USD listings, and
  // reasonably report them as rupees.
});
export type ProductsInput = z.input<typeof ProductsInputSchema>;

export const ProductCandidateSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  source: z.string().describe('Retail domain the candidate came from'),
  /**
   * Null until an agent extracts it. Phase 0 is retrieval only — no LLM runs
   * inside the tool layer, so nothing here is ever invented.
   */
  priceApprox: z.number().nullable(),
  currency: z.string().nullable(),
});
export type ProductCandidate = z.infer<typeof ProductCandidateSchema>;

export const ProductsOutputSchema = z.object({
  query: z.string(),
  candidates: z.array(ProductCandidateSchema),
  dataNotes: z.string(),
});
export type ProductsOutput = z.infer<typeof ProductsOutputSchema>;

/* ------------------------------------------------------------- preferences */

export const PreferenceKeySchema = z.enum([
  'home_city',
  'currency',
  'budget_style',
  'dietary',
  'travel_class',
  'accessibility',
  'interests',
  'avoid',
]);
export type PreferenceKey = z.infer<typeof PreferenceKeySchema>;

export const PreferenceSchema = z.object({
  key: PreferenceKeySchema,
  value: z.string().min(1).max(280),
  updatedAt: z.string(),
});
export type Preference = z.infer<typeof PreferenceSchema>;

export const SavePreferenceInputSchema = z.object({
  userId: z.string().min(1),
  key: PreferenceKeySchema,
  value: z.string().min(1).max(280),
});
export type SavePreferenceInput = z.input<typeof SavePreferenceInputSchema>;

export const GetPreferencesInputSchema = z.object({ userId: z.string().min(1) });
export type GetPreferencesInput = z.input<typeof GetPreferencesInputSchema>;

export const PreferencesOutputSchema = z.object({
  userId: z.string(),
  preferences: z.array(PreferenceSchema),
});
export type PreferencesOutput = z.infer<typeof PreferencesOutputSchema>;
