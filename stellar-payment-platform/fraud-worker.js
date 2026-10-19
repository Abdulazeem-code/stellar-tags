require('./src/utils/tracing');
require('./config/envCheck');
const { prisma } = require('./prismaClient');
const { startFraudDetectionWorker } = require('./src/fraudDetection');

startFraudDetectionWorker({ prisma }).catch(async (error) => {
  console.error('Unable to start fraud detection worker:', error);
  await prisma.$disconnect();
  process.exit(1);
});
