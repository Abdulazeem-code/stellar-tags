'use strict';

/**
 * In-memory stand-in for the Prisma client, used by the GraphQL tests.
 *
 * It implements only the operators the resolvers and loaders actually emit
 * (`in`, `equals`, `contains`, `not`, `gte`/`lte`, `OR`/`AND`/`NOT`, plus
 * `orderBy` / `skip` / `take`), which keeps it small enough to reason about
 * while still being strict enough that a wrong `where` clause fails the test.
 *
 * Every call is recorded on `prisma.__calls`, which is how the N+1 tests assert
 * a fixed query count.
 */

const isCondition = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

const compare = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (a instanceof Date || b instanceof Date) {
    return new Date(a).getTime() - new Date(b).getTime();
  }
  if (typeof a === 'string' && typeof b === 'string') {
    const left = Date.parse(a);
    const right = Date.parse(b);
    if (!Number.isNaN(left) && !Number.isNaN(right)) return left - right;
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  return 0;
};

const matchesCondition = (value, condition) => {
  if (condition === null) return value === null || value === undefined;
  if (!isCondition(condition)) return value === condition;

  if ('in' in condition && !condition.in.includes(value)) return false;
  if ('equals' in condition && value !== condition.equals) return false;
  if ('not' in condition && value === condition.not) return false;

  if ('contains' in condition) {
    const haystack = String(value ?? '').toLowerCase();
    if (!haystack.includes(String(condition.contains).toLowerCase())) return false;
  }

  if ('gte' in condition && compare(value, condition.gte) < 0) return false;
  if ('lte' in condition && compare(value, condition.lte) > 0) return false;
  if ('gt' in condition && compare(value, condition.gt) <= 0) return false;
  if ('lt' in condition && compare(value, condition.lt) >= 0) return false;

  return true;
};

const matches = (row, where) => {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return condition.some((sub) => matches(row, sub));
    if (key === 'AND') return condition.every((sub) => matches(row, sub));
    if (key === 'NOT') return !condition.some((sub) => matches(row, sub));
    return matchesCondition(row[key], condition);
  });
};

const sortRows = (rows, orderBy) => {
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      for (const [field, dir] of Object.entries(clause)) {
        const result = compare(a[field], b[field]);
        if (result !== 0) return dir === 'asc' ? result : -result;
      }
    }
    return 0;
  });
};

const applyWindow = (rows, args = {}) => {
  let out = rows;
  if (args.orderBy) out = sortRows(out, args.orderBy);
  if (args.skip) out = out.slice(args.skip);
  if (args.take !== undefined && args.take !== null) out = out.slice(0, args.take);
  return out;
};

const aggregate = (items, spec) => {
  if (!spec) return undefined;
  const result = {};
  for (const [field, enabled] of Object.entries(spec)) {
    result[field] = enabled
      ? items.reduce((total, item) => total + Number(item[field] || 0), 0)
      : undefined;
  }
  return result;
};

const pick = (row, select) => {
  const result = {};
  for (const [field, wanted] of Object.entries(select)) {
    if (wanted) result[field] = row[field];
  }
  return result;
};

/**
 * @param {object} [seed] arrays of rows, keyed `users`, `webhooks`, `payments`,
 *   `paymentIntents`, `activityLogs`.
 */
function createFakePrisma(seed = {}) {
  const rows = {
    user: [...(seed.users || [])],
    webhook: [...(seed.webhooks || [])],
    payment: [...(seed.payments || [])],
    paymentIntent: [...(seed.paymentIntents || [])],
    activityLog: [...(seed.activityLogs || [])],
  };

  const calls = [];

  const track = (model, op, impl) => (...args) => {
    calls.push({ model, op, args: args[0] });
    return Promise.resolve(impl(...args));
  };

  const model = (name, key, extra = {}) => ({
    findMany: track(name, 'findMany', (args = {}) =>
      applyWindow(rows[key].filter((row) => matches(row, args.where)), args),
    ),
    findFirst: track(name, 'findFirst', (args = {}) => {
      const found = sortRows(
        rows[key].filter((row) => matches(row, args.where)),
        args.orderBy || { createdAt: 'asc' },
      );
      const [first] = found;
      return args.select && first ? pick(first, args.select) : first ?? null;
    }),
    findUnique: track(name, 'findUnique', (args = {}) => {
      const [field] = Object.keys(args.where || {});
      const found = rows[key].find((row) => row[field] === args.where[field]);
      return found ?? null;
    }),
    count: track(name, 'count', (args = {}) =>
      rows[key].filter((row) => matches(row, args.where)).length,
    ),
    groupBy: track(name, 'groupBy', (args = {}) => {
      const by = args.by[0];
      const filtered = rows[key].filter((row) => matches(row, args.where));
      const groups = new Map();
      for (const row of filtered) {
        if (!groups.has(row[by])) groups.set(row[by], []);
        groups.get(row[by]).push(row);
      }
      return [...groups.entries()].map(([groupKey, items]) => {
        const group = { [by]: groupKey };
        if (args._count) group._count = { _all: items.length };
        if (args._sum) group._sum = aggregate(items, args._sum);
        return group;
      });
    }),
    ...extra,
  });

  const prisma = {
    user: model('user', 'user'),
    webhook: model('webhook', 'webhook'),
    payment: model('payment', 'payment', {
      aggregate: track('payment', 'aggregate', () => ({
        _sum: { amount: 0, fee: 0 },
        _count: { id: 0 },
      })),
    }),
    paymentIntent: model('paymentIntent', 'paymentIntent'),
    activityLog: model('activityLog', 'activityLog'),
    $transaction: (arg) =>
      Array.isArray(arg) ? Promise.all(arg) : Promise.resolve(arg(prisma)),
    $queryRaw: track('raw', '$queryRaw', () => [{ '?column?': 1 }]),
  };

  prisma.__calls = calls;
  prisma.__callsTo = (name, op) =>
    calls.filter((call) => call.model === name && (op === undefined || call.op === op));
  prisma.__reset = () => {
    calls.length = 0;
  };

  return prisma;
}

module.exports = { createFakePrisma, matches, sortRows };
