const request = require('supertest');
const { app } = require('../server');

describe('GET /federation', () => {
  // 'client' is seeded in USER_DATABASE inside server.js
  it('returns 200 with stellar address for a known user', async () => {
    const res = await request(app)
      .get('/federation')
      .query({ q: 'client*localhost' });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('stellar_address');
    expect(res.body).toHaveProperty('account_id');
  });

  it('returns 404 for an unknown user', async () => {
    const res = await request(app)
      .get('/federation')
      .query({ q: 'nonexistentuser*localhost' });

    expect(res.statusCode).toBe(404);
    expect(res.body).toHaveProperty('detail');
  });
});
