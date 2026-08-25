'use strict';

/**
 * src/services/statsService.js
 *
 * Service for calculating payment routing statistics and aggregation data.
 */

/**
 * Helper to extract bucket key from a Date based on interval.
 *
 * @param {Date|string} date
 * @param {'day'|'week'|'month'} interval
 * @returns {string} Bucket key formatted as:
 *   - 'day':   YYYY-MM-DD
 *   - 'week':  YYYY-MM-DD (Monday representing start of week in UTC)
 *   - 'month': YYYY-MM
 */
const getBucketKey = (date, interval) => {
  const d = new Date(date);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');

  if (interval === 'month') {
    return `${year}-${month}`;
  }

  if (interval === 'week') {
    // Start of week (Monday) in UTC
    const dayOfWeek = d.getUTCDay(); // 0 is Sunday, 1 is Monday, ..., 6 is Saturday
    const diff = (dayOfWeek === 0 ? -6 : 1) - dayOfWeek;
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
    const mYear = monday.getUTCFullYear();
    const mMonth = String(monday.getUTCMonth() + 1).padStart(2, '0');
    const mDay = String(monday.getUTCDate()).padStart(2, '0');
    return `${mYear}-${mMonth}-${mDay}`;
  }

  // Default: 'day' -> YYYY-MM-DD
  return `${year}-${month}-${day}`;
};

/**
 * Builds the Prisma `where` clause for the optional date-range filters.
 *
 * @param {string|undefined} startDate - ISO date string (YYYY-MM-DD).
 * @param {string|undefined} endDate   - ISO date string (YYYY-MM-DD).
 * @returns {object} Prisma where clause fragment.
 */
const buildDateFilter = (startDate, endDate) => {
  if (!startDate && !endDate) return {};

  const filter = {};
  if (startDate) {
    const start = new Date(startDate);
    start.setUTCHours(0, 0, 0, 0);
    filter.gte = start;
  }
  if (endDate) {
    const end = new Date(endDate);
    end.setUTCHours(23, 59, 59, 999);
    filter.lte = end;
  }
  return { createdAt: filter };
};

/**
 * Retrieves historical payment routing statistics aggregated by day, week, or month.
 *
 * @param {object} opts
 * @param {object} opts.prisma - Prisma client instance.
 * @param {string} [opts.startDate] - Inclusive start date (YYYY-MM-DD).
 * @param {string} [opts.endDate] - Inclusive end date (YYYY-MM-DD).
 * @param {'day'|'week'|'month'} [opts.groupBy='day'] - Grouping interval.
 * @param {'day'|'week'|'month'} [opts.interval] - Alias for groupBy.
 * @param {string} [opts.assetCode] - Optional asset filter.
 * @returns {Promise<object>} Grouped aggregation statistics and summary.
 */
const getRoutingStats = async ({
  prisma,
  startDate,
  endDate,
  groupBy,
  interval,
  assetCode,
}) => {
  const selectedInterval = interval || groupBy || 'day';
  const where = {
    ...buildDateFilter(startDate, endDate),
  };

  if (assetCode) {
    where.assetCode = assetCode;
  }

  const records = await prisma.payment.findMany({
    where,
    select: {
      id: true,
      createdAt: true,
      amount: true,
      fee: true,
      assetCode: true,
      status: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  let totalVolume = 0;
  let totalFees = 0;
  let totalCount = 0;

  const buckets = new Map();

  for (const record of records) {
    const amount = Number(record.amount) || 0;
    const fee = Number(record.fee) || 0;

    totalVolume += amount;
    totalFees += fee;
    totalCount += 1;

    const bucketKey = getBucketKey(record.createdAt, selectedInterval);
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, {
        period: bucketKey,
        volume: 0,
        fees: 0,
        count: 0,
      });
    }

    const bucket = buckets.get(bucketKey);
    bucket.volume = Number((bucket.volume + amount).toFixed(7));
    bucket.fees = Number((bucket.fees + fee).toFixed(7));
    bucket.count += 1;
  }

  const data = Array.from(buckets.values());

  return {
    interval: selectedInterval,
    startDate: startDate || null,
    endDate: endDate || null,
    summary: {
      total_volume: Number(totalVolume.toFixed(7)),
      total_fees: Number(totalFees.toFixed(7)),
      total_count: totalCount,
    },
    data,
  };
};

module.exports = {
  getRoutingStats,
  getBucketKey,
  buildDateFilter,
};
