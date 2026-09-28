const { context, propagation, trace } = require('@opentelemetry/api');

const injectTraceContext = (carrier = {}) => {
  propagation.inject(context.active(), carrier);
  return carrier;
};

const extractTraceContext = (carrier = {}) => propagation.extract(context.active(), carrier);

const currentTraceId = () => {
  const span = trace.getSpan(context.active());
  return span?.spanContext?.().traceId || undefined;
};

module.exports = { injectTraceContext, extractTraceContext, currentTraceId };
