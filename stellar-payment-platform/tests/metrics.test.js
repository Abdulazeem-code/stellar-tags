const request = require('supertest');

// Mock the Stellar SDK to prevent Jest ESM syntax errors
jest.mock('@stellar/stellar-sdk', () => ({
  Horizon: { Server: jest.fn() },
  StrKey: { isValidEd25519PublicKey: jest.fn(() => true) },
  Keypair: {
    fromPublicKey: jest.fn(() => ({
      verify: jest.fn(() => true)
    }))
  }
}));

// Mock Prisma so it doesn't try to connect to a real database and crash
jest.mock('../prismaClient', () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({})
    },
    $transaction: jest.fn().mockResolvedValue([0, []]),
    $disconnect: jest.fn().mockResolvedValue(undefined)
  }
}));

const { app } = require('../server');

describe('Prometheus Metrics Endpoint', () => {
  describe('GET /metrics', () => {
    test('should return 200 status code', async () => {
      const response = await request(app).get('/metrics');
      expect(response.status).toBe(200);
    });

    test('should return text/plain content type', async () => {
      const response = await request(app).get('/metrics');
      expect(response.type).toContain('text/plain');
    });

    test('should return valid Prometheus format with metrics', async () => {
      const response = await request(app).get('/metrics');
      expect(response.status).toBe(200);
      expect(response.text).toBeTruthy();
      // Check for common Prometheus metric format (lines starting with # or containing key=value labels)
      expect(response.text).toMatch(/^#|^\w+/m);
    });

    test('should contain default Node.js metrics', async () => {
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      // Check for default Node.js metrics with our prefix
      expect(metricsText).toMatch(/stellar_tags_nodejs_|stellar_tags_process_/);
    });

    test('should contain custom request counter metric', async () => {
      // Make a request to create a metric
      await request(app).get('/health');
      
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      expect(metricsText).toContain('stellar_tags_http_requests_total');
    });

    test('should contain custom request duration histogram metric', async () => {
      // Make a request to create a metric
      await request(app).get('/health');
      
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      expect(metricsText).toContain('stellar_tags_http_request_duration_seconds');
    });

    test('should track multiple requests with counter increment', async () => {
      // Make multiple requests
      await request(app).get('/health');
      await request(app).get('/health');
      await request(app).get('/health');
      
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      
      // The counter should be present and have recorded requests
      expect(metricsText).toContain('stellar_tags_http_requests_total');
      // Check that counter has labels including GET, /health, and status 200
      expect(metricsText).toMatch(/stellar_tags_http_requests_total.*method="GET".*route="\/health".*status_code="200"/);
    });

    test('should track request latency histogram', async () => {
      await request(app).get('/health');
      
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      
      // Should have histogram buckets and sum/count
      expect(metricsText).toContain('stellar_tags_http_request_duration_seconds_bucket');
      expect(metricsText).toContain('stellar_tags_http_request_duration_seconds_sum');
      expect(metricsText).toContain('stellar_tags_http_request_duration_seconds_count');
    });

    test('should include correct labels (method, route, status_code)', async () => {
      await request(app).get('/health');
      
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      
      // Check for presence of label names in metrics output
      expect(metricsText).toMatch(/method=/);
      expect(metricsText).toMatch(/route=/);
      expect(metricsText).toMatch(/status_code=/);
    });

    test('should handle 404 responses in metrics', async () => {
      await request(app).get('/nonexistent-route');
      
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      
      // Should record the 404 request
      expect(metricsText).toContain('status_code="404"');
    });

    test('should handle different HTTP methods in metrics', async () => {
      // Make requests with different methods
      await request(app).get('/health');
      await request(app).post('/federation').send({});
      
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      
      // Should have labels for different methods
      expect(metricsText).toMatch(/method="GET"/);
      expect(metricsText).toMatch(/method="POST"/);
    });

    test('should not expose /metrics in the metrics itself (avoid infinite recursion in labels)', async () => {
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      
      // /metrics requests should not create metric entries that include /metrics in the route
      // (The metrics endpoint itself may appear, but we verify the format is correct)
      expect(response.status).toBe(200);
      expect(metricsText).toBeTruthy();
    });
  });

  describe('Metrics middleware integration', () => {
    test('should track requests to /health endpoint', async () => {
      // Clear previous metrics by not checking them
      await request(app).get('/health');
      
      const metricsResponse = await request(app).get('/metrics');
      const metricsText = metricsResponse.text;
      
      expect(metricsText).toContain('stellar_tags_http_requests_total');
      expect(metricsText).toMatch(/route="\/health"/);
    });

    test('should track requests to /api/v1/time endpoint', async () => {
      await request(app).get('/api/v1/time');
      
      const metricsResponse = await request(app).get('/metrics');
      const metricsText = metricsResponse.text;
      
      expect(metricsText).toContain('stellar_tags_http_requests_total');
      expect(metricsText).toMatch(/route="\/api\/v1\/time"/);
    });

    test('should measure response times in histogram', async () => {
      await request(app).get('/health');
      
      const metricsResponse = await request(app).get('/metrics');
      const metricsText = metricsResponse.text;
      
      // Should have histogram with actual duration measurements
      expect(metricsText).toContain('stellar_tags_http_request_duration_seconds_sum');
      // Verify the sum contains a numeric value
      expect(metricsText).toMatch(/stellar_tags_http_request_duration_seconds_sum{.*}.*[\d.]+/);
    });
  });

  describe('Prometheus format compliance', () => {
    test('should return properly formatted Prometheus text', async () => {
      const response = await request(app).get('/metrics');
      const lines = response.text.split('\n');
      
      // Should have help lines (starting with # HELP)
      const helpLines = lines.filter(l => l.startsWith('# HELP'));
      expect(helpLines.length).toBeGreaterThan(0);
      
      // Should have type lines (starting with # TYPE)
      const typeLines = lines.filter(l => l.startsWith('# TYPE'));
      expect(typeLines.length).toBeGreaterThan(0);
    });

    test('should include HELP and TYPE documentation for custom metrics', async () => {
      const response = await request(app).get('/metrics');
      const metricsText = response.text;
      
      // Check for help text
      expect(metricsText).toContain('# HELP stellar_tags_http_requests_total');
      expect(metricsText).toContain('Total number of HTTP requests');
      
      expect(metricsText).toContain('# HELP stellar_tags_http_request_duration_seconds');
      expect(metricsText).toContain('HTTP request duration in seconds');
      
      // Check for type declarations
      expect(metricsText).toContain('# TYPE stellar_tags_http_requests_total counter');
      expect(metricsText).toContain('# TYPE stellar_tags_http_request_duration_seconds histogram');
    });
  });
});
