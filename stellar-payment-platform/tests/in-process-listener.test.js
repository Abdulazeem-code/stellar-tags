'use strict';

jest.mock('../src/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { logger } = require('../src/logger');

const loadModule = () => {
  let mod;
  jest.isolateModules(() => {
    mod = require('../src/inProcessListener');
  });
  return mod;
};

const fakeListener = () => ({
  main: jest.fn().mockResolvedValue({}),
  stop: jest.fn().mockResolvedValue(undefined),
});

describe('in-process Horizon listener', () => {
  beforeEach(() => jest.clearAllMocks());

  test('the flag is off unless RUN_HORIZON_LISTENER is "true"', () => {
    const { isInProcessListenerEnabled } = loadModule();
    expect(isInProcessListenerEnabled({})).toBe(false);
    expect(isInProcessListenerEnabled({ RUN_HORIZON_LISTENER: 'false' })).toBe(false);
    expect(isInProcessListenerEnabled({ RUN_HORIZON_LISTENER: '1' })).toBe(false);
    expect(isInProcessListenerEnabled({ RUN_HORIZON_LISTENER: 'true' })).toBe(true);
    expect(isInProcessListenerEnabled({ RUN_HORIZON_LISTENER: ' TRUE ' })).toBe(true);
  });

  test('does not load the listener when the flag is off', async () => {
    const { startInProcessListener } = loadModule();
    const load = jest.fn();
    await expect(startInProcessListener({ env: {}, load })).resolves.toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  test('starts the listener once when the flag is on', async () => {
    const { startInProcessListener } = loadModule();
    const listener = fakeListener();
    const load = jest.fn(() => listener);
    const env = { RUN_HORIZON_LISTENER: 'true' };

    await expect(startInProcessListener({ env, load })).resolves.toBe(true);
    await expect(startInProcessListener({ env, load })).resolves.toBe(true);

    expect(load).toHaveBeenCalledTimes(1);
    expect(listener.main).toHaveBeenCalledTimes(1);
  });

  test('a start failure is logged, not thrown, and can be retried', async () => {
    const { startInProcessListener } = loadModule();
    const broken = { main: jest.fn().mockRejectedValue(new Error('horizon down')), stop: jest.fn() };
    const env = { RUN_HORIZON_LISTENER: 'true' };

    await expect(startInProcessListener({ env, load: () => broken })).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalled();

    const healthy = fakeListener();
    await expect(startInProcessListener({ env, load: () => healthy })).resolves.toBe(true);
    expect(healthy.main).toHaveBeenCalledTimes(1);
  });

  test('stop() stops a running listener once and is safe to call again', async () => {
    const { startInProcessListener, stopInProcessListener, isInProcessListenerRunning } = loadModule();
    const listener = fakeListener();
    expect(isInProcessListenerRunning()).toBe(false);
    await startInProcessListener({ env: { RUN_HORIZON_LISTENER: 'true' }, load: () => listener });
    expect(isInProcessListenerRunning()).toBe(true);

    await stopInProcessListener();
    await stopInProcessListener();

    expect(listener.stop).toHaveBeenCalledTimes(1);
    expect(isInProcessListenerRunning()).toBe(false);
  });

  test('stop() without a running listener does nothing', async () => {
    const { stopInProcessListener } = loadModule();
    await expect(stopInProcessListener()).resolves.toBeUndefined();
  });

  test('a stop failure is logged, not thrown', async () => {
    const { startInProcessListener, stopInProcessListener } = loadModule();
    const listener = { main: jest.fn().mockResolvedValue({}), stop: jest.fn().mockRejectedValue(new Error('boom')) };
    await startInProcessListener({ env: { RUN_HORIZON_LISTENER: 'true' }, load: () => listener });

    await expect(stopInProcessListener()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
