'use strict';

function parsePagination(query, defaultLimit = 10, maxLimit = 100) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

function paginatedResponse(data, totalCount, { page, limit }) {
  const totalPages = Math.ceil(totalCount / limit);
  return {
    data,
    meta: { total: totalCount, page, limit, totalPages },
    totalCount,
    totalPages,
    currentPage: page,
  };
}

module.exports = { parsePagination, paginatedResponse };
