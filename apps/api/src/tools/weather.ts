/**
 * Weather — Open-Meteo. No API key, no signup, no rate limit worth worrying
 * about at demo volume.
 *
 * Open-Meteo has its own free geocoding endpoint, so this tool resolves place
 * names itself rather than depending on Geoapify. That keeps the whole weather
 * path zero-key, which matters: it is the tool we use to prove the harness
 * works before any credentials exist.
 */
import { fetchJson, runTool } from '../lib/http.js';
import {
  WeatherInputSchema,
  WeatherOutputSchema,
  type WeatherInput,
  type WeatherOutput,
  type ToolResult,
} from '@lifepilot/shared';

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

interface GeocodeResponse {
  results?: Array<{
    name: string;
    latitude: number;
    longitude: number;
    country?: string;
    admin1?: string;
    timezone?: string;
  }>;
}

interface ForecastResponse {
  timezone: string;
  daily: {
    time: string[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: Array<number | null>;
    weather_code: number[];
  };
}

/** WMO weather interpretation codes, condensed to what a planner cares about. */
const WMO_CODES: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snowfall',
  73: 'Moderate snowfall',
  75: 'Heavy snowfall',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

export async function getWeather(rawInput: WeatherInput): Promise<ToolResult<WeatherOutput>> {
  return runTool(async () => {
    const input = WeatherInputSchema.parse(rawInput);

    const geo = await fetchJson<GeocodeResponse>(
      `${GEOCODE_URL}?name=${encodeURIComponent(input.location)}&count=1&language=en&format=json`,
    );
    const match = geo.results?.[0];
    if (!match) {
      throw new Error(`No location found matching "${input.location}"`);
    }

    const params = new URLSearchParams({
      latitude: String(match.latitude),
      longitude: String(match.longitude),
      daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code',
      timezone: 'auto',
      forecast_days: String(input.days),
    });
    const forecast = await fetchJson<ForecastResponse>(`${FORECAST_URL}?${params}`);

    const label = [match.name, match.admin1, match.country].filter(Boolean).join(', ');

    const days = forecast.daily.time.map((date, i) => ({
      date,
      tempMinC: forecast.daily.temperature_2m_min[i] ?? 0,
      tempMaxC: forecast.daily.temperature_2m_max[i] ?? 0,
      precipitationChancePct: forecast.daily.precipitation_probability_max[i] ?? null,
      summary: WMO_CODES[forecast.daily.weather_code[i] ?? -1] ?? 'Unknown',
    }));

    return WeatherOutputSchema.parse({
      resolvedLocation: label,
      coordinates: { lat: match.latitude, lon: match.longitude },
      timezone: forecast.timezone,
      days,
    });
  });
}
