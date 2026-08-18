/**
 * Guards tool schemas against the Gemini function-declaration subset.
 *
 * Gemini accepts a restricted subset of OpenAPI 3.0 for function declarations.
 * Zod happily emits keywords outside it, and the failure is remote, late, and
 * badly localised: `z.number().positive()` serialises to `exclusiveMinimum` and
 * the whole request comes back as
 *
 *   400 Invalid JSON payload received. Unknown name "exclusiveMinimum" at
 *   'tools[0].function_declarations[1].parameters.properties[0].value'
 *
 * — an index-based path that names neither the tool nor the field. A test walks
 * every tool through this, so the failure lands at `npm test` on the schema
 * that caused it instead of on the first live agent call.
 */

/**
 * Keywords Gemini rejects. Not exhaustive for all of JSON Schema — this is the
 * set reachable from ordinary Zod usage. Add to it whenever the API teaches us
 * a new one.
 */
const UNSUPPORTED_KEYWORDS = [
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'additionalProperties',
  'patternProperties',
  'const',
  'oneOf',
  'allOf',
  'not',
  '$ref',
  '$defs',
  'definitions',
  'dependentRequired',
  'unevaluatedProperties',
] as const;

export interface SchemaViolation {
  tool: string;
  /** Dotted path to the offending node, e.g. "parameters.properties.amount". */
  path: string;
  keyword: string;
}

/** Walks a declaration and reports every unsupported keyword it contains. */
export function findSchemaViolations(toolName: string, schema: unknown): SchemaViolation[] {
  const violations: SchemaViolation[] = [];

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== 'object') return;

    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if ((UNSUPPORTED_KEYWORDS as readonly string[]).includes(key)) {
        violations.push({ tool: toolName, path: path ? `${path}.${key}` : key, keyword: key });
      }
      walk(value, path ? `${path}.${key}` : key);
    }
  };

  walk(schema, '');
  return violations;
}

/** Throws with an actionable message if any tool would be rejected by Gemini. */
export function assertGeminiCompatible(
  tools: Array<{ _getDeclaration(): unknown }>,
): void {
  const violations = tools.flatMap((tool) => {
    const declaration = tool._getDeclaration() as { name?: string };
    return findSchemaViolations(declaration.name ?? 'unnamed', declaration);
  });

  if (violations.length > 0) {
    const detail = violations.map((v) => `  ${v.tool}: ${v.path} uses "${v.keyword}"`).join('\n');
    throw new Error(
      `Tool schemas use keywords the Gemini function-declaration schema rejects:\n${detail}\n\n` +
        'Common causes: .positive()/.negative() emit exclusiveMinimum/exclusiveMaximum ' +
        '(use .min(0)/.max(0)); .multipleOf() and z.union() of objects are also unsupported.',
    );
  }
}
