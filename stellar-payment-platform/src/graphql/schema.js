'use strict';

/**
 * #685 — SDL -> executable schema.
 *
 * `graphql` has no built-in "SDL plus a resolver map" helper (that is what
 * `@graphql-tools/schema` normally provides), so this module does the small
 * amount of wiring that is actually required:
 *
 *   1. parse the SDL and build the schema, so syntax and type errors fail at
 *      boot rather than on the first request;
 *   2. graft each resolver onto its field — graphql-js reads `resolve` off the
 *      field definition at execution time, so assigning it after construction is
 *      equivalent to passing it in the constructor;
 *   3. graft the scalar implementations onto the declared custom scalars.
 *
 * There are no interfaces or unions in the schema, so no `resolveType` hook is
 * needed and every type resolves from a plain object.
 */

const {
  buildASTSchema,
  parse,
  isObjectType,
  isInterfaceType,
  isUnionType,
  isScalarType,
  valueFromASTUntyped,
  Kind,
} = require('graphql');

/**
 * Serialize anything date-like to an ISO-8601 string. Prisma hands back
 * `Date` objects, the raw-SQL fallbacks hand back strings, and a couple of
 * paths already pre-format; all three are accepted so a field resolver does not
 * have to care which one produced the row.
 */
const serializeDateTime = (value) => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    const asDate = new Date(value);
    return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
  }
  return String(value);
};

const parseDateTimeInput = (value) => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`DateTime cannot represent value: ${String(value)}`);
  }
  return parsed;
};

const dateTimeScalar = {
  serialize: serializeDateTime,
  parseValue: parseDateTimeInput,
  parseLiteral(node) {
    if (node.kind !== Kind.STRING) {
      throw new TypeError('DateTime must be provided as a string.');
    }
    return parseDateTimeInput(node.value);
  },
};

const jsonScalar = {
  serialize: (value) => (value === undefined ? null : value),
  parseValue: (value) => value,
  parseLiteral: (node, variables) => valueFromASTUntyped(node, variables),
};

/**
 * Resolver implementations for the custom scalars declared in the SDL.
 * `graphql` builds these as plain writable properties on the scalar instance,
 * so assigning over them replaces the placeholder generated from the SDL.
 */
const scalarResolvers = {
  DateTime: dateTimeScalar,
  JSON: jsonScalar,
};

/**
 * Attach a resolver map to a built schema, in place.
 *
 * Unknown type or field names are ignored rather than throwing: a resolver map
 * that has drifted from the SDL is a programming error, but silently dropping
 * it would turn into a confusing "field resolves to null" at runtime. It is
 * logged instead.
 *
 * @param {import('graphql').GraphQLSchema} schema
 * @param {Record<string, Record<string, Function>|Function>} resolvers
 * @returns {import('graphql').GraphQLSchema} the same schema, for chaining
 */
function attachResolvers(schema, resolvers = {}) {
  for (const [typeName, definition] of Object.entries(resolvers)) {
    if (!definition) continue;

    const type = schema.getType(typeName);
    if (!type) {
      console.warn(`[graphql] resolver map references unknown type "${typeName}"`);
      continue;
    }

    if (isScalarType(type)) {
      Object.assign(type, definition);
      continue;
    }

    if (isUnionType(type)) {
      if (typeof definition.resolveType === 'function') {
        type.resolveType = definition.resolveType;
      }
      continue;
    }

    if (!isObjectType(type) && !isInterfaceType(type)) continue;

    const fields = type.getFields();
    for (const [fieldName, resolve] of Object.entries(definition)) {
      if (fieldName.startsWith('__')) continue;
      if (!fields[fieldName]) {
        console.warn(
          `[graphql] resolver map references unknown field "${typeName}.${fieldName}"`,
        );
        continue;
      }
      if (typeof resolve === 'function') {
        fields[fieldName].resolve = resolve;
      }
    }
  }

  return schema;
}

/**
 * Compile the SDL and attach the resolvers.
 *
 * @param {{ typeDefs: string, resolvers?: object, scalars?: object }} options
 * @returns {import('graphql').GraphQLSchema}
 */
function makeSchema({ typeDefs, resolvers = {}, scalars = scalarResolvers }) {
  const schema = buildASTSchema(parse(typeDefs));
  return attachResolvers(schema, { ...scalars, ...resolvers });
}

module.exports = {
  makeSchema,
  attachResolvers,
  serializeDateTime,
  parseDateTimeInput,
  scalarResolvers,
};
