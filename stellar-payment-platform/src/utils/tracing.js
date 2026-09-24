const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { ZipkinExporter } = require('@opentelemetry/exporter-zipkin');
const { PrismaInstrumentation } = require('@prisma/instrumentation');

const sdk = new NodeSDK({
  traceExporter: new ZipkinExporter({
    url: process.env.ZIPKIN_ENDPOINT || 'http://localhost:9411/api/v2/spans',
    serviceName: 'stellar-tags-api',
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // We are tracing Express, HTTP, and Prisma out-of-the-box
      '@opentelemetry/instrumentation-express': { enabled: true },
      '@opentelemetry/instrumentation-http': { enabled: true },
    }),
    new PrismaInstrumentation()
  ]
});

sdk.start();

process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('Tracing terminated'))
    .catch((error) => console.log('Error terminating tracing', error))
    .finally(() => process.exit(0));
});
