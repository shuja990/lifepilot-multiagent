/**
 * Places and geocoding — Geoapify (OpenStreetMap-derived).
 *
 * Chosen over Google Places because the free plan is 3,000 credits/day with no
 * credit card, versus Google's per-SKU free counts which a chatty agent burns
 * through quickly. See docs/PLAN.md §3.1.
 *
 * The tradeoff is real and is surfaced to the agent in `dataNotes` rather than
 * hidden: OSM has no ratings, reviews, or photos. Anything ranking-shaped must
 * be answered by the search tool, not invented from this data.
 */
import { fetchJson, runTool } from '../lib/http.js';
import { requireEnv } from '../config/env.js';
import {
  GeocodeInputSchema,
  GeocodeOutputSchema,
  PlacesInputSchema,
  PlacesOutputSchema,
  type GeocodeInput,
  type GeocodeOutput,
  type PlaceCategory,
  type PlacesInput,
  type PlacesOutput,
  type ToolResult,
} from '@lifepilot/shared';

const GEOCODE_URL = 'https://api.geoapify.com/v1/geocode/search';
const PLACES_URL = 'https://api.geoapify.com/v2/places';

const DATA_NOTES =
  'Source: OpenStreetMap via Geoapify. No ratings, reviews, or photos are ' +
  'available from this dataset, and coverage varies by region. Do not imply ' +
  'popularity or quality ranking from these results — use web search for that.';

/**
 * Our closed category set mapped onto Geoapify's taxonomy. This mapping is the
 * only thing that has to change if the provider is ever swapped.
 */
const CATEGORY_MAP: Record<PlaceCategory, string> = {
  restaurant: 'catering.restaurant',
  cafe: 'catering.cafe',
  hotel: 'accommodation.hotel',
  attraction: 'tourism.attraction',
  museum: 'entertainment.museum',
  park: 'leisure.park',
  shopping: 'commercial.shopping_mall',
  pharmacy: 'healthcare.pharmacy',
  hospital: 'healthcare.hospital',
  airport: 'airport',
  train_station: 'public_transport.train',
  atm: 'service.financial.atm',
};

interface GeoapifyFeature {
  properties: {
    name?: string;
    formatted?: string;
    address_line1?: string;
    lat: number;
    lon: number;
    country?: string;
    city?: string;
    distance?: number;
    categories?: string[];
    website?: string;
    phone?: string;
    opening_hours?: string;
    datasource?: { raw?: Record<string, unknown> };
  };
}

interface GeoapifyResponse {
  features?: GeoapifyFeature[];
}

export async function geocode(rawInput: GeocodeInput): Promise<ToolResult<GeocodeOutput>> {
  return runTool(async () => {
    const input = GeocodeInputSchema.parse(rawInput);
    const apiKey = requireEnv('GEOAPIFY_API_KEY');

    const url = `${GEOCODE_URL}?text=${encodeURIComponent(input.query)}&limit=1&format=json&apiKey=${apiKey}`;
    const response = await fetchJson<{ results?: Array<Record<string, any>> }>(url);

    const hit = response.results?.[0];
    if (!hit) throw new Error(`No location found matching "${input.query}"`);

    return GeocodeOutputSchema.parse({
      formatted: hit.formatted ?? input.query,
      coordinates: { lat: hit.lat, lon: hit.lon },
      country: hit.country ?? null,
      city: hit.city ?? null,
    });
  });
}

export async function findPlaces(rawInput: PlacesInput): Promise<ToolResult<PlacesOutput>> {
  return runTool(async () => {
    const input = PlacesInputSchema.parse(rawInput);
    const apiKey = requireEnv('GEOAPIFY_API_KEY');

    // Resolve the anchor first — Places needs coordinates, not a place name.
    const centerResult = await geocode({ query: input.near });
    if (!centerResult.ok) throw new Error(centerResult.error);
    const center = centerResult.data;

    const params = new URLSearchParams({
      categories: CATEGORY_MAP[input.category],
      filter: `circle:${center.coordinates.lon},${center.coordinates.lat},${input.radiusMeters}`,
      bias: `proximity:${center.coordinates.lon},${center.coordinates.lat}`,
      limit: String(input.limit),
      apiKey,
    });

    const response = await fetchJson<GeoapifyResponse>(`${PLACES_URL}?${params}`);

    const places = (response.features ?? [])
      .map((feature) => {
        const p = feature.properties;
        return {
          name: p.name ?? p.address_line1 ?? 'Unnamed place',
          address: p.formatted ?? null,
          coordinates: { lat: p.lat, lon: p.lon },
          distanceMeters: typeof p.distance === 'number' ? p.distance : null,
          categories: p.categories ?? [],
          website: p.website ?? null,
          phone: p.phone ?? null,
          openingHours: p.opening_hours ?? null,
        };
      })
      // OSM entries without a name are near-useless to a planner.
      .filter((place) => place.name !== 'Unnamed place');

    return PlacesOutputSchema.parse({
      resolvedLocation: center.formatted,
      center: center.coordinates,
      places,
      dataNotes: DATA_NOTES,
    });
  });
}
