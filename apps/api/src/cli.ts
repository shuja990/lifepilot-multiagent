/**
 * Standalone tool runner.
 *
 * docs/PLAN.md makes this a rule rather than a convenience: every tool must be
 * runnable without an agent, because tools get debugged far more often than
 * agents do and you should never need an LLM in the loop to find out whether
 * an API call works.
 *
 *   npm run tool -- weather Lisbon 3
 *   npm run tool -- places "Tokyo" cafe
 *   npm run tool -- currency 250 USD JPY
 *   npm run tool -- search "best time to visit Patagonia"
 *   npm run tool -- products "noise cancelling headphones"
 *   npm run tool -- prefs:set demo-user home_city Berlin
 *   npm run tool -- prefs:get demo-user
 */
import { convertCurrency } from './tools/currency.js';
import { findPlaces, geocode } from './tools/places.js';
import { findProducts } from './tools/products.js';
import { getPreferences, savePreference } from './tools/preferences.js';
import { getWeather } from './tools/weather.js';
import { webSearch } from './tools/search.js';
import { toToolError } from './lib/http.js';
import type { ToolResult } from '@lifepilot/shared';

type Runner = (args: string[]) => Promise<ToolResult<unknown>>;

const COMMANDS: Record<string, { usage: string; run: Runner }> = {
  weather: {
    usage: 'weather <location> [days]',
    run: ([location, days]) =>
      getWeather({ location: required(location, 'location'), days: days ? Number(days) : 3 }),
  },
  geocode: {
    usage: 'geocode <query>',
    run: (args) => geocode({ query: required(args.join(' '), 'query') }),
  },
  places: {
    usage: 'places <near> <category> [radiusMeters] [limit]',
    run: ([near, category, radius, limit]) =>
      findPlaces({
        near: required(near, 'near'),
        category: required(category, 'category') as never,
        radiusMeters: radius ? Number(radius) : 5000,
        limit: limit ? Number(limit) : 8,
      }),
  },
  currency: {
    usage: 'currency <amount> <from> <to>',
    run: ([amount, from, to]) =>
      convertCurrency({
        amount: Number(required(amount, 'amount')),
        from: required(from, 'from'),
        to: required(to, 'to'),
      }),
  },
  search: {
    usage: 'search <query...>',
    run: (args) => webSearch({ query: required(args.join(' '), 'query') }),
  },
  products: {
    usage: 'products <query...>',
    run: (args) => findProducts({ query: required(args.join(' '), 'query') }),
  },
  'prefs:set': {
    usage: 'prefs:set <userId> <key> <value...>',
    run: ([userId, key, ...rest]) =>
      savePreference({
        userId: required(userId, 'userId'),
        key: required(key, 'key') as never,
        value: required(rest.join(' '), 'value'),
      }),
  },
  'prefs:get': {
    usage: 'prefs:get <userId>',
    run: ([userId]) => getPreferences({ userId: required(userId, 'userId') }),
  },
};

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing argument: ${name}`);
  return value;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  // Object.hasOwn, not truthiness: `COMMANDS['constructor']` is inherited from
  // Object.prototype and would sail past an `in`/truthy guard.
  const known = command ? Object.hasOwn(COMMANDS, command) : false;

  if (!command || command === 'help' || !known) {
    if (command && command !== 'help') console.error(`Unknown tool: ${command}\n`);
    console.log('Usage: npm run tool -- <tool> [args]\n');
    for (const { usage } of Object.values(COMMANDS)) console.log(`  ${usage}`);
    process.exit(command && command !== 'help' ? 1 : 0);
  }

  const started = Date.now();
  // Argument errors are thrown synchronously by required(), outside runTool, so
  // normalise them here — otherwise CLI failures come in two different shapes.
  let result: ToolResult<unknown>;
  try {
    result = await COMMANDS[command]!.run(args);
  } catch (error) {
    result = toToolError(error);
  }
  const elapsed = Date.now() - started;

  if (result.ok) {
    console.log(JSON.stringify(result.data, null, 2));
    // Phase 0 asks for real latency numbers for the README; this is where they come from.
    console.error(`\nok in ${elapsed}ms`);
  } else {
    console.error(`FAILED in ${elapsed}ms: ${result.error}`);
    if (result.missingEnv) {
      console.error(`\nSet ${result.missingEnv} in .env — see .env.example for the free signup link.`);
    }
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
