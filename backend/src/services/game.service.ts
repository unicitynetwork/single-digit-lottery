import crypto from 'crypto';
import { Round, Bet, IRound, IBet, IBetItem } from '../models/game.model.js';
import { nostrService } from './index.js';

const PAYOUT_MULTIPLIER = 9; // 1:9 payout ratio

export class GameService {
  // Generate cryptographically secure random digit
  static generateWinningDigit(): number {
    return crypto.randomInt(0, 10);
  }

  // Create new round (handles race condition with duplicate key)
  static async createRound(): Promise<IRound> {
    const lastRound = await Round.findOne().sort({ roundNumber: -1 });
    const roundNumber = lastRound ? lastRound.roundNumber + 1 : 1;

    try {
      const round = new Round({
        roundNumber,
        status: 'open',
        startTime: new Date(),
      });

      return (await round.save()) as unknown as IRound;
    } catch (error) {
      // Handle duplicate key error (race condition)
      if (error instanceof Error && 'code' in error && (error as { code: number }).code === 11000) {
        const existingRound = await Round.findOne({ roundNumber });
        if (existingRound) {
          return existingRound as IRound;
        }
      }
      throw error;
    }
  }

  // Get current open round or create new one
  static async getCurrentRound(): Promise<IRound> {
    const round = await Round.findOne({ status: 'open' });

    if (!round) {
      return this.createRound();
    }

    return round as IRound;
  }

  // Place bets - creates invoice and returns it for user to pay
  static async placeBets(
    userNametag: string,
    bets: IBetItem[]
  ): Promise<{ bet: IBet; invoice: { invoiceId: string; amount: number } }> {
    // Validate bets
    if (!bets || bets.length === 0) {
      throw new Error('At least one bet required');
    }

    for (const bet of bets) {
      if (bet.digit < 0 || bet.digit > 9) {
        throw new Error('Digit must be between 0 and 9');
      }
      if (bet.amount <= 0) {
        throw new Error('Amount must be positive');
      }
    }

    const round = await this.getCurrentRound();

    if (round.status !== 'open') {
      throw new Error('Round is not open for betting');
    }

    // Calculate total amount
    const totalAmount = bets.reduce((sum, bet) => sum + bet.amount, 0);

    // Create invoice via Nostr (pass bets for message details)
    const invoice = await nostrService.createInvoice(userNametag, totalAmount, bets);

    // Create bet record
    const betRecord = new Bet({
      roundId: round._id,
      userNametag,
      bets,
      totalAmount,
      invoiceId: invoice.invoiceId,
      paymentStatus: 'pending',
    });

    await betRecord.save();

    return {
      bet: betRecord as IBet,
      invoice,
    };
  }

  // Called when payment is confirmed (webhook or polling)
  static async confirmPayment(invoiceId: string, txId: string): Promise<IBet> {
    const bet = await Bet.findOne({ invoiceId });

    if (!bet) {
      throw new Error('Bet not found');
    }

    if (bet.paymentStatus === 'paid') {
      return bet as IBet;
    }

    bet.paymentStatus = 'paid';
    bet.paymentTxId = txId;
    await bet.save();

    // Update round pool
    await Round.findByIdAndUpdate(bet.roundId, {
      $inc: { totalPool: bet.totalAmount },
    });

    return bet as IBet;
  }

  // Close round - stop accepting bets
  static async closeRound(roundId: string): Promise<IRound> {
    const round = await Round.findById(roundId);

    if (!round) {
      throw new Error('Round not found');
    }

    if (round.status !== 'open') {
      throw new Error('Round is not open');
    }

    round.status = 'closed';
    round.endTime = new Date();
    await round.save();

    return round as IRound;
  }

  // Draw winning number
  static async drawWinner(roundId: string): Promise<IRound> {
    const round = await Round.findById(roundId);

    if (!round) {
      throw new Error('Round not found');
    }

    if (round.status !== 'closed') {
      throw new Error('Round must be closed before drawing');
    }

    round.status = 'drawing';
    const winningDigit = this.generateWinningDigit();
    round.winningDigit = winningDigit;
    round.drawTime = new Date();
    await round.save();

    // Calculate winnings for all paid bets
    await this.calculateWinnings(round);

    round.status = 'paying';
    await round.save();

    return round as IRound;
  }

  // Calculate winnings for all bets in a round
  static async calculateWinnings(round: IRound): Promise<void> {
    const bets = await Bet.find({
      roundId: round._id,
      paymentStatus: 'paid',
    });

    for (const bet of bets) {
      let winnings = 0;

      for (const betItem of bet.bets) {
        if (betItem.digit === round.winningDigit) {
          winnings += betItem.amount * PAYOUT_MULTIPLIER;
        }
      }

      if (winnings > 0) {
        bet.winnings = winnings;
        bet.payoutStatus = 'pending';
        await bet.save();
      }
    }
  }

  // Process payouts (called by cron job)
  static async processPayouts(roundId: string): Promise<{ processed: number; failed: number }> {
    const bets = await Bet.find({
      roundId,
      winnings: { $gt: 0 },
      payoutStatus: 'pending',
    });

    let processed = 0;
    let failed = 0;

    for (const bet of bets) {
      try {
        bet.payoutStatus = 'sent';
        await bet.save();

        const transfer = await nostrService.sendTokens(bet.userNametag, bet.winnings);

        bet.payoutTxId = transfer.transferId;
        bet.payoutStatus = 'confirmed';
        await bet.save();

        processed++;
      } catch {
        bet.payoutStatus = 'failed';
        await bet.save();
        failed++;
      }
    }

    // Update round if all payouts done
    const pendingPayouts = await Bet.countDocuments({
      roundId,
      winnings: { $gt: 0 },
      payoutStatus: { $in: ['pending', 'sent'] },
    });

    if (pendingPayouts === 0) {
      const totalPayout = await Bet.aggregate([
        { $match: { roundId: new (await import('mongoose')).Types.ObjectId(roundId) } },
        { $group: { _id: null, total: { $sum: '$winnings' } } },
      ]);

      await Round.findByIdAndUpdate(roundId, {
        status: 'completed',
        totalPayout: totalPayout[0]?.total || 0,
      });
    }

    return { processed, failed };
  }

  // Get previous completed round (with winning digit)
  static async getPreviousRound(): Promise<IRound | null> {
    return Round.findOne({ status: 'completed' }).sort({ roundNumber: -1 });
  }

  // Get round history
  static async getRoundHistory(limit = 10): Promise<IRound[]> {
    return Round.find({ status: 'completed' }).sort({ roundNumber: -1 }).limit(limit);
  }

  // Get user bets
  static async getUserBets(userNametag: string, limit = 20): Promise<IBet[]> {
    return Bet.find({ userNametag }).sort({ createdAt: -1 }).limit(limit).populate('roundId');
  }

  // Get bets for a round
  static async getRoundBets(roundId: string): Promise<IBet[]> {
    return Bet.find({ roundId, paymentStatus: 'paid' });
  }
}
