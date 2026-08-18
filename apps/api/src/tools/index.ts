/**
 * The tool layer, wrapped for ADK.
 *
 * The plain functions in this directory stay agent-agnostic and CLI-runnable;
 * this file is the only place that knows ADK exists. That separation is what
 * lets every tool be debugged without an LLM in the loop.
 *
 * Descriptions here are prompt surface, not documentation. They are written for
 * the model: what the tool is for, and — just as importantly — what it cannot
 * do, so the model routes ranking questions to search instead of inventing them
 * from OpenStreetMap data.
 */
import { FunctionTool } from '@google/adk';

import { convertCurrency } from './currency.js';
import { findPlaces, geocode } from './places.js';
import { findProducts } from './products.js';
import { getPreferences, savePreference } from './preferences.js';
import { getWeather } from './weather.js';
import { webSearch } from './search.js';

import {
  CurrencyInputSchema,
  GeocodeInputSchema,
  GetPreferencesInputSchema,
  PlacesInputSchema,
  ProductsInputSchema,
  SavePreferenceInputSchema,
  SearchInputSchema,
  WeatherInputSchema,
} from '@lifepilot/shared';

export const weatherTool = new FunctionTool({
  name: 'get_weather',
  description:
    'Daily weather forecast for a place, up to 16 days ahead. Use before ' +
    'recommending outdoor activities or packing. Temperatures may be null for ' +
    'days at the far edge of the forecast window — treat null as unknown, ' +
    'never as zero.',
  parameters: WeatherInputSchema,
  execute: (input) => getWeather(input),
});

export const currencyTool = new FunctionTool({
  name: 'convert_currency',
  description:
    'Convert an amount between currencies using daily reference rates. Use ' +
    'whenever a budget mixes currencies. Rates are indicative, not the rate a ' +
    'traveller gets at a counter, so present converted figures as approximate.',
  parameters: CurrencyInputSchema,
  execute: (input) => convertCurrency(input),
});

export const geocodeTool = new FunctionTool({
  name: 'geocode',
  description:
    'Resolve an address or place name to coordinates and a normalised name. ' +
    'Use to disambiguate a vague location before searching around it.',
  parameters: GeocodeInputSchema,
  execute: (input) => geocode(input),
});

export const placesTool = new FunctionTool({
  name: 'find_places',
  description:
    'Find real places of a given category near a location (restaurants, ' +
    'cafes, hotels, attractions, museums, parks, shopping, pharmacies, ' +
    'hospitals, airports, train stations, ATMs). Returns names, addresses and ' +
    'distances from OpenStreetMap. IMPORTANT: this data has NO ratings, ' +
    'reviews, photos or popularity signal. Never rank these results by quality ' +
    'or call one "the best" — use web_search for that.',
  parameters: PlacesInputSchema,
  execute: (input) => findPlaces(input),
});

export const searchTool = new FunctionTool({
  name: 'web_search',
  description:
    'Search the live web for current information: opinions, rankings, ' +
    'reviews, opening times, travel advice, prices in context. Use this for ' +
    'anything subjective or time-sensitive that the structured tools cannot ' +
    'answer. Each call costs quota, so search once with a good query rather ' +
    'than several times with narrow ones.',
  parameters: SearchInputSchema,
  execute: (input) => webSearch(input),
});

export const productsTool = new FunctionTool({
  name: 'find_products',
  description:
    'Find real retail listings for something the user wants to buy. Returns ' +
    'titles, links and the retailer. IMPORTANT: prices are NOT included — ' +
    'priceApprox is always null. Do not infer a price from a title or snippet; ' +
    'say the listing must be opened to confirm price and availability.',
  parameters: ProductsInputSchema,
  execute: (input) => findProducts(input),
});

export const savePreferenceTool = new FunctionTool({
  name: 'save_preference',
  description:
    'Remember a durable fact about the user across future conversations — ' +
    'home city, preferred currency, dietary needs, travel class, ' +
    'accessibility needs, interests, things to avoid. Only call this for ' +
    'lasting preferences the user has actually stated, never for one-off ' +
    'details of the current request, and never for something merely inferred.',
  parameters: SavePreferenceInputSchema,
  execute: (input) => savePreference(input),
});

export const getPreferencesTool = new FunctionTool({
  name: 'get_preferences',
  description:
    'Look up what is already known about the user before asking them. Call ' +
    'this early so you do not ask for something they have already told us.',
  parameters: GetPreferencesInputSchema,
  execute: (input) => getPreferences(input),
});

/** Every tool, for the Phase 1 single-agent baseline. */
export const ALL_TOOLS = [
  weatherTool,
  currencyTool,
  geocodeTool,
  placesTool,
  searchTool,
  productsTool,
  savePreferenceTool,
  getPreferencesTool,
];

/** Research-shaped tools — the fan-out set used by the Phase 3 swarm. */
export const RESEARCH_TOOLS = [searchTool, placesTool, geocodeTool, weatherTool, productsTool];
