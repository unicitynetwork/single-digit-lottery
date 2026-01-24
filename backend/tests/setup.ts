import express, { Application } from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import gameRoutes from '../src/routes/game.routes.js';

// Set mock mode for tests
process.env.MOCK_MODE = 'true';
process.env.AGENT_NAMETAG = 'test-agent';

export async function createTestApp(): Promise<Application> {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use('/api/game', gameRoutes);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  return app;
}

export async function connectTestDB(): Promise<void> {
  const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/single-digit-lottery-test';
  await mongoose.connect(mongoUri);
}

export async function disconnectTestDB(): Promise<void> {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

export async function clearTestDB(): Promise<void> {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    await collections[key].deleteMany({});
  }
}
