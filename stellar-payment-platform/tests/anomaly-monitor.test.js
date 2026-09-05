jest.mock('node-cron', () => ({
  schedule: jest.fn(),
}));

const cron = require('node-cron');
const {
  runAnomalyMonitor,
  scheduleAnomalyMonitor,
  getDailyAverageVolume,
  getWindowVolume,
  ANOMALY_THRESHOLD_MULTIPLIER,
  WINDOW_HOURS,
} = require('../src/scripts/anomalyMonitor');

describe('anomaly-monitor', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ANOMALY_SLACK_WEBHOOK_URL;
    delete process.env.ANOMALY_EMAIL_WEBHOOK_URL;
    delete process.env.ANOMALY_AUTO_PAUSE;
  });

  describe('getWindowVolume', () => {
    it('sums amounts for an account within the window', async () => {
      const prisma = {
        paymentIntent: {
          findMany: jest.fn().mockResolvedValue([
            { amount: '100' },
            { amount: '50' },
            { amount: '25' },
          ]),
        },
      };

      const volume = await getWindowVolume(prisma, 'GABC', new Date());
      expect(volume).toBe(175);
      expect(prisma.paymentIntent.findMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('getDailyAverageVolume', () => {
    it('returns 0 when there is insufficient history', async () => {
      const prisma = {
        paymentIntent: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };

      const avg = await getDailyAverageVolume(prisma, 'GABC', new Date());
      expect(avg).toBe(0);
    });

    it('returns 0 when fewer than MIN_HISTORY_DAYS active days exist', async () => {
      const now = new Date();
      const prisma = {
        paymentIntent: {
          findMany: jest.fn().mockResolvedValue([
            { amount: '100', createdAt: now },
            { amount: '50', createdAt: now },
          ]),
        },
      };

      const avg = await getDailyAverageVolume(prisma, 'GABC', new Date());
      expect(avg).toBe(0);
    });

    it('computes average over active days', async () => {
      const day1 = new Date('2024-01-01T10:00:00Z');
      const day2 = new Date('2024-01-02T10:00:00Z');
      const day3 = new Date('2024-01-03T10:00:00Z');
      const prisma = {
        paymentIntent: {
          findMany: jest.fn().mockResolvedValue([
            { amount: '100', createdAt: day1 },
            { amount: '100', createdAt: day1 },
            { amount: '200', createdAt: day2 },
            { amount: '300', createdAt: day3 },
          ]),
        },
      };

      // day1=200, day2=200, day3=300 → avg = 700/3 ≈ 233.33
      const avg = await getDailyAverageVolume(prisma, 'GABC', new Date('2024-01-10'));
      expect(avg).toBeCloseTo(233.33, 1);
    });
  });

  describe('runAnomalyMonitor', () => {
    it('flags accounts exceeding the threshold and dispatches alerts', async () => {
      const now = new Date();
      const windowStart = new Date(now);
      windowStart.setHours(windowStart.getHours() - WINDOW_HOURS);

      const prisma = {
        paymentIntent: {
          findMany: jest.fn().mockImplementation(({ where }) => {
            if (where.createdAt.gte) {
              return [
                { from: 'GABC', to: 'GDEF', amount: '1000' },
                { from: 'GABC', to: 'GDEF', amount: '1000' },
              ];
            }
            return [
              { amount: '10', createdAt: new Date('2024-01-01T10:00:00Z') },
              { amount: '10', createdAt: new Date('2024-01-02T10:00:00Z') },
              { amount: '10', createdAt: new Date('2024-01-03T10:00:00Z') },
            ];
          }),
        },
      };

      const anomalies = await runAnomalyMonitor(prisma);

      // Window volume for GABC = 2000, daily average = 10 → ratio 200x ≥ 10x
      expect(anomalies.length).toBeGreaterThan(0);
      expect(anomalies[0].address).toBe('GABC');
      expect(anomalies[0].ratio).toBeGreaterThanOrEqual(ANOMALY_THRESHOLD_MULTIPLIER);
    });

    it('does not flag accounts within normal volume', async () => {
      const prisma = {
        paymentIntent: {
          findMany: jest.fn().mockImplementation(({ where }) => {
            if (where.createdAt.gte) {
              return [{ from: 'GABC', to: 'GDEF', amount: '10' }];
            }
            return [
              { amount: '10', createdAt: new Date('2024-01-01T10:00:00Z') },
              { amount: '10', createdAt: new Date('2024-01-02T10:00:00Z') },
              { amount: '10', createdAt: new Date('2024-01-03T10:00:00Z') },
            ];
          }),
        },
        user: {
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      };

      const anomalies = await runAnomalyMonitor(prisma);
      expect(anomalies).toEqual([]);
    });

    it('auto-pauses flagged accounts when enabled', async () => {
      process.env.ANOMALY_AUTO_PAUSE = 'true';

      const prisma = {
        paymentIntent: {
          findMany: jest.fn().mockImplementation(({ where }) => {
            if (where.createdAt.gte) {
              return [{ from: 'GABC', to: 'GDEF', amount: '1000' }];
            }
            return [
              { amount: '10', createdAt: new Date('2024-01-01T10:00:00Z') },
              { amount: '10', createdAt: new Date('2024-01-02T10:00:00Z') },
              { amount: '10', createdAt: new Date('2024-01-03T10:00:00Z') },
            ];
          }),
        },
        user: {
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };

      await runAnomalyMonitor(prisma);
      expect(prisma.user.updateMany).toHaveBeenCalled();
    });
  });

  describe('scheduleAnomalyMonitor', () => {
    it('registers a cron job', () => {
      const prisma = { paymentIntent: { findMany: jest.fn() }, user: { updateMany: jest.fn() } };
      scheduleAnomalyMonitor(prisma);
      expect(cron.schedule).toHaveBeenCalledWith('*/15 * * * *', expect.any(Function));
    });
  });
});
