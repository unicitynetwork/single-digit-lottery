import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Round, Bet, IRound, IBet } from '../src/models/game.model.js';

describe('Models', () => {
  beforeAll(async () => {
    await mongoose.connect('mongodb://localhost:27017/lottery-test-models');
    // Ensure indexes are created
    await Round.createIndexes();
    await Bet.createIndexes();
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  beforeEach(async () => {
    await Round.deleteMany({});
    await Bet.deleteMany({});
  });

  // ==================== ROUND MODEL ====================
  describe('Round Model', () => {
    it('should create round with required fields', async () => {
      const round = new Round({
        roundNumber: 1,
        status: 'open',
        startTime: new Date(),
      });

      const saved = await round.save();

      expect(saved._id).toBeDefined();
      expect(saved.roundNumber).toBe(1);
      expect(saved.status).toBe('open');
      expect(saved.totalPool).toBe(0);
      expect(saved.totalPayout).toBe(0);
      expect(saved.winningDigit).toBeNull();
    });

    it('should set default values', async () => {
      const round = new Round({
        roundNumber: 2,
      });

      const saved = await round.save();

      expect(saved.status).toBe('open');
      expect(saved.totalPool).toBe(0);
      expect(saved.totalPayout).toBe(0);
      expect(saved.winningDigit).toBeNull();
      expect(saved.endTime).toBeNull();
      expect(saved.drawTime).toBeNull();
    });

    it('should enforce unique roundNumber', async () => {
      await Round.create({ roundNumber: 1 });

      await expect(Round.create({ roundNumber: 1 })).rejects.toThrow();
    });

    it('should validate status enum', async () => {
      const round = new Round({
        roundNumber: 3,
        status: 'invalid-status' as any,
      });

      await expect(round.save()).rejects.toThrow();
    });

    it('should validate winningDigit range (0-9)', async () => {
      const round = new Round({
        roundNumber: 4,
        winningDigit: 10,
      });

      await expect(round.save()).rejects.toThrow();
    });

    it('should allow winningDigit 0', async () => {
      const round = new Round({
        roundNumber: 5,
        winningDigit: 0,
      });

      const saved = await round.save();
      expect(saved.winningDigit).toBe(0);
    });

    it('should have timestamps', async () => {
      const round = await Round.create({ roundNumber: 6 });

      expect(round.createdAt).toBeDefined();
      expect(round.updatedAt).toBeDefined();
    });

    it('should update updatedAt on modification', async () => {
      const round = await Round.create({ roundNumber: 7 });
      const originalUpdatedAt = round.updatedAt;

      await new Promise((r) => setTimeout(r, 10));

      round.status = 'closed';
      await round.save();

      expect(round.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
    });
  });

  // ==================== BET MODEL ====================
  describe('Bet Model', () => {
    let round: IRound;

    beforeEach(async () => {
      round = await Round.create({ roundNumber: 1 });
    });

    it('should create bet with required fields', async () => {
      const bet = new Bet({
        roundId: round._id,
        roundNumber: 1,
        userNametag: 'player1',
        bets: [{ digit: 5, amount: 100 }],
        totalAmount: 100,
        invoiceId: 'inv-123',
      });

      const saved = await bet.save();

      expect(saved._id).toBeDefined();
      expect(saved.userNametag).toBe('player1');
      expect(saved.totalAmount).toBe(100);
      expect(saved.paymentStatus).toBe('pending');
    });

    it('should set default values', async () => {
      const bet = await Bet.create({
        roundId: round._id,
        roundNumber: 1,
        userNametag: 'player2',
        bets: [{ digit: 3, amount: 50 }],
        totalAmount: 50,
        invoiceId: 'inv-456',
      });

      expect(bet.paymentStatus).toBe('pending');
      expect(bet.paymentTxId).toBeNull();
      expect(bet.winnings).toBe(0);
      expect(bet.payoutStatus).toBe('none');
      expect(bet.payoutTxId).toBeNull();
    });

    it('should enforce unique invoiceId', async () => {
      await Bet.create({
        roundId: round._id,
        roundNumber: 1,
        userNametag: 'player3',
        bets: [{ digit: 1, amount: 10 }],
        totalAmount: 10,
        invoiceId: 'unique-inv',
      });

      await expect(
        Bet.create({
          roundId: round._id,
          userNametag: 'player4',
          bets: [{ digit: 2, amount: 20 }],
          totalAmount: 20,
          invoiceId: 'unique-inv',
        })
      ).rejects.toThrow();
    });

    it('should validate digit range in bets (0-9)', async () => {
      const bet = new Bet({
        roundId: round._id,
        roundNumber: 1,
        userNametag: 'player5',
        bets: [{ digit: 15, amount: 100 }],
        totalAmount: 100,
        invoiceId: 'inv-789',
      });

      await expect(bet.save()).rejects.toThrow();
    });

    it('should validate amount minimum (1)', async () => {
      const bet = new Bet({
        roundId: round._id,
        roundNumber: 1,
        userNametag: 'player6',
        bets: [{ digit: 5, amount: 0 }],
        totalAmount: 0,
        invoiceId: 'inv-zero',
      });

      await expect(bet.save()).rejects.toThrow();
    });

    it('should require at least one bet', async () => {
      const bet = new Bet({
        roundId: round._id,
        roundNumber: 1,
        userNametag: 'player7',
        bets: [],
        totalAmount: 0,
        invoiceId: 'inv-empty',
      });

      await expect(bet.save()).rejects.toThrow();
    });

    it('should validate paymentStatus enum', async () => {
      const bet = new Bet({
        roundId: round._id,
        roundNumber: 1,
        userNametag: 'player8',
        bets: [{ digit: 7, amount: 100 }],
        totalAmount: 100,
        invoiceId: 'inv-status',
        paymentStatus: 'invalid' as any,
      });

      await expect(bet.save()).rejects.toThrow();
    });

    it('should validate payoutStatus enum', async () => {
      const bet = new Bet({
        roundId: round._id,
        roundNumber: 1,
        userNametag: 'player9',
        bets: [{ digit: 8, amount: 100 }],
        totalAmount: 100,
        invoiceId: 'inv-payout',
        payoutStatus: 'invalid' as any,
      });

      await expect(bet.save()).rejects.toThrow();
    });

    it('should store multiple bets correctly', async () => {
      const bet = await Bet.create({
        roundId: round._id,
        roundNumber: 1,
        userNametag: 'multi-better',
        bets: [
          { digit: 0, amount: 10 },
          { digit: 5, amount: 50 },
          { digit: 9, amount: 40 },
        ],
        totalAmount: 100,
        invoiceId: 'inv-multi',
      });

      expect(bet.bets).toHaveLength(3);
      expect(bet.bets[0].digit).toBe(0);
      expect(bet.bets[1].digit).toBe(5);
      expect(bet.bets[2].digit).toBe(9);
    });

    it('should have compound index on roundId and userNametag', async () => {
      // Ensure indexes are synced - this creates indexes defined in schema
      await Bet.syncIndexes();

      const indexes = await Bet.collection.getIndexes();

      // The compound index should have both roundId and userNametag as keys
      // Index format: { _id_: {...}, roundId_1: {...}, userNametag_1: {...}, roundId_1_userNametag_1: {...} }
      const indexNames = Object.keys(indexes);
      const hasCompoundIndex = indexNames.some(
        (name) => name.includes('roundId') && name.includes('userNametag')
      );
      expect(hasCompoundIndex).toBe(true);
    });

    it('should populate roundId reference', async () => {
      const bet = await Bet.create({
        roundId: round._id,
        roundNumber: 1,
        userNametag: 'pop-test',
        bets: [{ digit: 4, amount: 100 }],
        totalAmount: 100,
        invoiceId: 'inv-pop',
      });

      const populated = await Bet.findById(bet._id).populate('roundId');

      expect((populated!.roundId as any).roundNumber).toBe(1);
    });
  });

  // ==================== MODEL RELATIONSHIPS ====================
  describe('Model Relationships', () => {
    it('should find bets by round', async () => {
      const round1 = await Round.create({ roundNumber: 1 });
      const round2 = await Round.create({ roundNumber: 2 });

      await Bet.create({
        roundId: round1._id,
        roundNumber: 1,
        userNametag: 'r1-player',
        bets: [{ digit: 1, amount: 100 }],
        totalAmount: 100,
        invoiceId: 'inv-r1',
      });

      await Bet.create({
        roundId: round2._id,
        roundNumber: 2,
        userNametag: 'r2-player',
        bets: [{ digit: 2, amount: 200 }],
        totalAmount: 200,
        invoiceId: 'inv-r2',
      });

      const round1Bets = await Bet.find({ roundId: round1._id });
      const round2Bets = await Bet.find({ roundId: round2._id });

      expect(round1Bets).toHaveLength(1);
      expect(round1Bets[0].userNametag).toBe('r1-player');

      expect(round2Bets).toHaveLength(1);
      expect(round2Bets[0].userNametag).toBe('r2-player');
    });

    it('should find bets by user', async () => {
      const round = await Round.create({ roundNumber: 1 });

      await Bet.create({
        roundId: round._id,
        roundNumber: 1,
        userNametag: 'alice',
        bets: [{ digit: 1, amount: 100 }],
        totalAmount: 100,
        invoiceId: 'inv-alice-1',
      });

      await Bet.create({
        roundId: round._id,
        roundNumber: 1,
        userNametag: 'alice',
        bets: [{ digit: 2, amount: 200 }],
        totalAmount: 200,
        invoiceId: 'inv-alice-2',
      });

      await Bet.create({
        roundId: round._id,
        roundNumber: 1,
        userNametag: 'bob',
        bets: [{ digit: 3, amount: 300 }],
        totalAmount: 300,
        invoiceId: 'inv-bob',
      });

      const aliceBets = await Bet.find({ userNametag: 'alice' });
      const bobBets = await Bet.find({ userNametag: 'bob' });

      expect(aliceBets).toHaveLength(2);
      expect(bobBets).toHaveLength(1);
    });

    it('should find paid bets for round', async () => {
      const round = await Round.create({ roundNumber: 1 });

      await Bet.create({
        roundId: round._id,
        roundNumber: 1,
        userNametag: 'paid-user',
        bets: [{ digit: 5, amount: 100 }],
        totalAmount: 100,
        invoiceId: 'inv-paid',
        paymentStatus: 'paid',
      });

      await Bet.create({
        roundId: round._id,
        roundNumber: 1,
        userNametag: 'pending-user',
        bets: [{ digit: 6, amount: 100 }],
        totalAmount: 100,
        invoiceId: 'inv-pending',
        paymentStatus: 'pending',
      });

      const paidBets = await Bet.find({ roundId: round._id, paymentStatus: 'paid' });

      expect(paidBets).toHaveLength(1);
      expect(paidBets[0].userNametag).toBe('paid-user');
    });
  });
});
