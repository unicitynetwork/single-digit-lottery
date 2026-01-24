import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { vi } from 'vitest';

// Mock nostrService
vi.mock('../src/services/index.js', () => ({
  nostrService: {
    createInvoice: vi.fn().mockResolvedValue({
      invoiceId: 'mock-invoice',
      amount: 100,
      recipientNametag: 'test-agent',
      status: 'pending',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 120000),
    }),
    sendTokens: vi.fn().mockResolvedValue({
      transferId: 'mock-transfer',
      toNametag: 'user',
      amount: 100,
      status: 'confirmed',
      createdAt: new Date(),
    }),
  },
}));

import { RoundScheduler } from '../src/services/round-scheduler.service.js';
import { GameService } from '../src/services/game.service.js';
import { Round, Bet } from '../src/models/game.model.js';

describe('RoundScheduler', () => {
  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/lottery-test-scheduler');
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Round.deleteMany({});
    await Bet.deleteMany({});
  });

  describe('constructor', () => {
    it('should set round duration correctly', () => {
      const scheduler = new RoundScheduler(60);
      expect(scheduler.getRoundDurationMs()).toBe(60000);
    });

    it('should not be running initially', () => {
      const scheduler = new RoundScheduler(60);
      expect(scheduler.isRunning()).toBe(false);
    });
  });

  describe('start', () => {
    it('should set running to true', async () => {
      const scheduler = new RoundScheduler(300);

      await scheduler.start();

      expect(scheduler.isRunning()).toBe(true);

      scheduler.stop();
    });

    it('should be idempotent', async () => {
      const scheduler = new RoundScheduler(300);

      await scheduler.start();
      await scheduler.start();

      expect(scheduler.isRunning()).toBe(true);

      scheduler.stop();
    });
  });

  describe('stop', () => {
    it('should stop the scheduler', async () => {
      const scheduler = new RoundScheduler(300);

      await scheduler.start();
      scheduler.stop();

      expect(scheduler.isRunning()).toBe(false);
    });
  });

  describe('round execution', () => {
    it('should schedule round end based on duration', async () => {
      const scheduler = new RoundScheduler(1); // 1 second for faster test

      // Create initial round
      const round = await GameService.createRound();

      await scheduler.start();

      // Wait for round to complete
      await new Promise((r) => setTimeout(r, 1500));

      scheduler.stop();

      // Check round was closed
      const closedRound = await Round.findById(round._id);
      expect(closedRound!.status).toBe('completed');
    }, 10000); // 10 second timeout

    it('should create new round after completing previous', async () => {
      const scheduler = new RoundScheduler(1); // 1 second

      await GameService.createRound();

      await scheduler.start();

      // Wait for round to complete and new one to be created
      await new Promise((r) => setTimeout(r, 1500));

      scheduler.stop();

      const rounds = await Round.find().sort({ roundNumber: -1 });
      expect(rounds.length).toBeGreaterThanOrEqual(2);
      expect(rounds[0].status).toBe('open');
    }, 10000);

    it('should calculate remaining time correctly for existing round', async () => {
      // Create round that started 500ms ago
      const round = await GameService.createRound();
      round.startTime = new Date(Date.now() - 500);
      await round.save();

      const scheduler = new RoundScheduler(1); // 1 second total

      await scheduler.start();

      // Should only wait ~500ms more
      await new Promise((r) => setTimeout(r, 1000));

      scheduler.stop();

      const closedRound = await Round.findById(round._id);
      expect(closedRound!.status).toBe('completed');
    }, 10000);
  });
});
