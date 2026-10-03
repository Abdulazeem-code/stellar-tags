require('dotenv').config();

if (process.env.NODE_ENV === 'test') {
  module.exports = {
    sdk: null,
    sdkStarted: Promise.resolve(),
    shutdownTracing: () => Promise.resolve(),
  };
} else {
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { ZipkinExporter } = require('@opentelemetry/exporter-zipkin');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { PrismaInstrumentation } = require('@prisma/instrumentation');

  const serviceName = process.env.OTEL_SERVICE_NAME || 'stellar-tags-api';
  process.env.OTEL_SERVICE_NAME = serviceName; // Let OpenTelemetry auto-detect it

  const exporterName = (process.env.OTEL_TRACES_EXPORTER || 'otlp').toLowerCase();
  const traceExporter = exporterName === 'none'
    ? undefined
    : exporterName === 'zipkin'
      ? new ZipkinExporter({
          url: process.env.OTEL_EXPORTER_ZIPKIN_ENDPOINT || process.env.ZIPKIN_ENDPOINT || 'http://localhost:9411/api/v2/spans',
          serviceName,
        })
      : new OTLPTraceExporter({
          url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
          headers: process.env.OTEL_EXPORTER_OTLP_HEADERS
            ? Object.fromEntries(process.env.OTEL_EXPORTER_OTLP_HEADERS.split(',').map((entry) => {
                const separator = entry.indexOf('=');
                return separator < 0
                  ? [entry.trim(), '']
                  : [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
              }))
            : undefined,
        });

  const sdk = new NodeSDK({
    ...(traceExporter ? { traceExporter } : {}),
    instrumentations: [
      getNodeAutoInstrumentations({
        // Capture incoming/outgoing HTTP, Express, PostgreSQL, Redis and ioredis.
        '@opentelemetry/instrumentation-express': { enabled: true },
        '@opentelemetry/instrumentation-http': { enabled: true },
        '@opentelemetry/instrumentation-pg': { enabled: true },
        '@opentelemetry/instrumentation-ioredis': { enabled: true },
        '@opentelemetry/instrumentation-redis-4': { enabled: true },
      }),
      new PrismaInstrumentation(),
    ],
  });

  const sdkStarted = sdk.start();

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      Promise.resolve(sdkStarted)
        .then(() => sdk.shutdown())
        .catch((error) => console.error('Error shutting down tracing', error))
        .finally(() => process.exit(0));
    });
  }

  module.exports = { sdk, sdkStarted, shutdownTracing: () => sdk.shutdown() };
}
