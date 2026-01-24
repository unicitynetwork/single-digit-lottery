import crypto from 'crypto';
import mongoose from 'mongoose';
import {
  Round,
  Bet,
  Commission,
  PaymentLog,
  IRound,
  IBet,
  IBetItem,
} from '../models/game.model.js';
import { nostrService } from './index.js';
import { config } from '../env.js';

export class GameService {
  // Log payment to database
  private static async logPayment(params: {
    type: 'incoming' | 'outgoing';
    amount: number;
    fromNametag?: string | null;
    toNametag?: string | null;
    txId: string;
    relatedBetId?: mongoose.Types.ObjectId | null;
    relatedRoundId?: mongoose.Types.ObjectId | null;
    purpose: 'bet_payment' | 'payout' | 'refund' | 'commission_withdrawal';
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      await PaymentLog.create({
        type: params.type,
        amount: params.amount,
        fromNametag: params.fromNametag || null,
        toNametag: params.toNametag || null,
        txId: params.txId,
        relatedBetId: params.relatedBetId || null,
        relatedRoundId: params.relatedRoundId || null,
        purpose: params.purpose,
        status: 'confirmed',
        metadata: params.metadata || {},
      });
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[GameService] Failed to log payment:', error);
    }
  }
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

    // Create invoice via Nostr (pass bets and roundNumber for validation)
    const invoice = await nostrService.createInvoice(
      userNametag,
      totalAmount,
      bets,
      round.roundNumber
    );

    // Create bet record
    const betRecord = new Bet({
      roundId: round._id,
      roundNumber: round.roundNumber,
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
  static async confirmPayment(
    invoiceId: string,
    txId: string
  ): Promise<{ bet: IBet; accepted: boolean; refundReason?: string }> {
    const bet = await Bet.findOne({ invoiceId });

    if (!bet) {
      throw new Error('Bet not found');
    }

    if (bet.paymentStatus === 'paid') {
      return { bet: bet as IBet, accepted: true };
    }

    if (bet.paymentStatus === 'refunded') {
      return { bet: bet as IBet, accepted: false, refundReason: 'Already refunded' };
    }

    // Check if round is still open
    const round = await Round.findById(bet.roundId);

    if (!round) {
      // Round doesn't exist - refund
      const reason = 'Round not found';
      bet.paymentStatus = 'refunded';
      bet.paymentTxId = txId;
      bet.refundReason = reason;
      await bet.save();

      // Initiate refund
      await this.refundPayment(bet, reason);
      return { bet: bet as IBet, accepted: false, refundReason: reason };
    }

    if (round.status !== 'open') {
      // Round is closed - refund
      const reason = `Round #${round.roundNumber} is ${round.status}`;
      bet.paymentStatus = 'refunded';
      bet.paymentTxId = txId;
      bet.refundReason = reason;
      await bet.save();

      // Initiate refund
      await this.refundPayment(bet, reason);
      return {
        bet: bet as IBet,
        accepted: false,
        refundReason: reason,
      };
    }

    // Round is open - accept payment
    bet.paymentStatus = 'paid';
    bet.paymentTxId = txId;
    await bet.save();

    // Log incoming payment
    await this.logPayment({
      type: 'incoming',
      amount: bet.totalAmount,
      fromNametag: bet.userNametag,
      toNametag: config.agentNametag,
      txId,
      relatedBetId: bet._id as mongoose.Types.ObjectId,
      relatedRoundId: bet.roundId,
      purpose: 'bet_payment',
      metadata: { roundNumber: round.roundNumber, bets: bet.bets },
    });

    // Update round pool
    await Round.findByIdAndUpdate(bet.roundId, {
      $inc: { totalPool: bet.totalAmount },
    });

    return { bet: bet as IBet, accepted: true };
  }

  // Refund payment to user
  private static async refundPayment(bet: IBet, reason: string): Promise<void> {
    try {
      // eslint-disable-next-line no-console
      console.log(
        `[GameService] Refunding ${bet.totalAmount} UCT to @${bet.userNametag}: ${reason}`
      );

      const transfer = await nostrService.sendTokens(bet.userNametag, bet.totalAmount);
      bet.refundTxId = transfer.transferId;
      await bet.save();

      // Log outgoing refund
      await this.logPayment({
        type: 'outgoing',
        amount: bet.totalAmount,
        fromNametag: config.agentNametag,
        toNametag: bet.userNametag,
        txId: transfer.transferId,
        relatedBetId: bet._id as mongoose.Types.ObjectId,
        relatedRoundId: bet.roundId,
        purpose: 'refund',
        metadata: {
          reason,
          roundNumber: bet.roundNumber,
          originalBets: bet.bets,
        },
      });

      // eslint-disable-next-line no-console
      console.log(`[GameService] Refund sent: ${transfer.transferId}`);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`[GameService] Refund failed:`, error);
    }
  }

  // Close round - stop accepting bets
  static async closeRound(roundId: string): Promise<IRound> {
    // Use atomic update to prevent race conditions
    const round = await Round.findOneAndUpdate(
      { _id: roundId, status: 'open' },
      { $set: { status: 'closed', endTime: new Date() } },
      { new: true }
    );

    if (!round) {
      throw new Error('Round not found or not open');
    }

    return round as IRound;
  }

  // Draw winning number
  static async drawWinner(roundId: string): Promise<IRound> {
    const winningDigit = this.generateWinningDigit();

    // Use atomic update to prevent race conditions
    const round = await Round.findOneAndUpdate(
      { _id: roundId, status: 'closed' },
      {
        $set: {
          status: 'drawing',
          winningDigit,
          drawTime: new Date(),
        },
      },
      { new: true }
    );

    if (!round) {
      throw new Error('Round not found or not closed');
    }

    // Calculate winnings for all paid bets
    await this.calculateWinnings(round);

    round.status = 'paying';
    await round.save();

    return round as IRound;
  }

  // Calculate winnings using pari-mutuel logic (pool-based)
  static async calculateWinnings(round: IRound): Promise<void> {
    const bets = await Bet.find({
      roundId: round._id,
      paymentStatus: 'paid',
    });

    if (bets.length === 0) {
      // eslint-disable-next-line no-console
      console.log(`[GameService] No paid bets in round #${round.roundNumber}`);
      return;
    }

    // Calculate total bets on the winning digit
    let totalWinningBets = 0;
    for (const bet of bets) {
      for (const betItem of bet.bets) {
        if (betItem.digit === round.winningDigit) {
          totalWinningBets += betItem.amount;
        }
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[GameService] Pool: ${round.totalPool} UCT, Winning digit: ${round.winningDigit}, Bets on winner: ${totalWinningBets} UCT`
    );

    // Calculate losing bets (bets not on winning digit)
    const losingBets = round.totalPool - totalWinningBets;

    if (totalWinningBets === 0) {
      // No winners - entire pool goes to house fee
      const houseFee = round.totalPool;
      await this.addCommission(houseFee);

      round.houseFee = houseFee;
      await round.save();

      // eslint-disable-next-line no-console
      console.log(`[GameService] No winners - ${houseFee} UCT added to commission`);
      return;
    }

    // Calculate house fee (percentage of LOSING bets only)
    const houseFeePercent = config.houseFeePercent;
    const houseFee = Math.floor((losingBets * houseFeePercent) / 100);
    const winningPool = losingBets - houseFee; // Pool to distribute among winners

    // eslint-disable-next-line no-console
    console.log(
      `[GameService] Losing bets: ${losingBets} UCT, House fee: ${houseFee} UCT (${houseFeePercent}%), Winning pool: ${winningPool} UCT`
    );

    // Add house fee to commission
    await this.addCommission(houseFee);

    round.houseFee = houseFee;
    await round.save();

    // Distribute winnings: original bet + proportional share of winning pool
    let totalPayout = 0;

    for (const bet of bets) {
      let userWinningBet = 0;

      for (const betItem of bet.bets) {
        if (betItem.digit === round.winningDigit) {
          userWinningBet += betItem.amount;
        }
      }

      if (userWinningBet > 0) {
        // User gets: original bet back + proportional share of winning pool
        const shareOfPool = Math.floor((userWinningBet / totalWinningBets) * winningPool);
        const winnings = userWinningBet + shareOfPool;

        bet.winnings = winnings;
        bet.payoutStatus = 'pending';
        await bet.save();

        totalPayout += winnings;

        // eslint-disable-next-line no-console
        console.log(
          `[GameService] @${bet.userNametag} bet ${userWinningBet} on ${round.winningDigit}, wins ${winnings} UCT (${userWinningBet} + ${shareOfPool})`
        );
      }
    }

    round.totalPayout = totalPayout;
    await round.save();
  }

  // Add commission to accumulated total
  private static async addCommission(amount: number): Promise<void> {
    await Commission.findOneAndUpdate({}, { $inc: { totalAccumulated: amount } }, { upsert: true });
  }

  // Process payouts (called by cron job)
  static async processPayouts(roundId: string): Promise<{ processed: number; failed: number }> {
    const round = await Round.findById(roundId);
    if (!round) {
      throw new Error('Round not found');
    }

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

        // Find the winning bet details
        const winningBetItem = bet.bets.find((b) => b.digit === round.winningDigit);

        // Log outgoing payout
        await this.logPayment({
          type: 'outgoing',
          amount: bet.winnings,
          fromNametag: config.agentNametag,
          toNametag: bet.userNametag,
          txId: transfer.transferId,
          relatedBetId: bet._id as mongoose.Types.ObjectId,
          relatedRoundId: bet.roundId,
          purpose: 'payout',
          metadata: {
            roundNumber: bet.roundNumber,
            winningDigit: round.winningDigit,
            betOnWinningDigit: winningBetItem?.amount || 0,
            totalBetAmount: bet.totalAmount,
            userBets: bet.bets,
          },
        });

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

  // Get user bets in current round
  static async getUserBetsInCurrentRound(userNametag: string): Promise<IBet[]> {
    const round = await this.getCurrentRound();
    return Bet.find({
      roundId: round._id,
      userNametag,
      paymentStatus: 'paid',
    }).sort({ createdAt: -1 });
  }

  // Get commission balance
  static async getCommissionBalance(): Promise<{
    totalAccumulated: number;
    totalWithdrawn: number;
    available: number;
  }> {
    const commission = await Commission.findOne();
    if (!commission) {
      return { totalAccumulated: 0, totalWithdrawn: 0, available: 0 };
    }

    return {
      totalAccumulated: commission.totalAccumulated,
      totalWithdrawn: commission.totalWithdrawn,
      available: commission.totalAccumulated - commission.totalWithdrawn,
    };
  }

  // Withdraw commission to developer nametag
  static async withdrawCommission(
    amount?: number
  ): Promise<{ success: boolean; amount: number; txId?: string; error?: string }> {
    const developerNametag = config.developerNametag;

    if (!developerNametag) {
      return { success: false, amount: 0, error: 'Developer nametag not configured' };
    }

    const balance = await this.getCommissionBalance();

    if (balance.available <= 0) {
      return { success: false, amount: 0, error: 'No commission available for withdrawal' };
    }

    // Withdraw all available if no amount specified
    const withdrawAmount = amount ? Math.min(amount, balance.available) : balance.available;

    if (withdrawAmount <= 0) {
      return { success: false, amount: 0, error: 'Invalid withdrawal amount' };
    }

    try {
      // eslint-disable-next-line no-console
      console.log(`[GameService] Withdrawing ${withdrawAmount} UCT to @${developerNametag}`);

      const transfer = await nostrService.sendTokens(developerNametag, withdrawAmount);

      // Update commission record
      await Commission.findOneAndUpdate(
        {},
        {
          $inc: { totalWithdrawn: withdrawAmount },
          lastWithdrawalAt: new Date(),
        }
      );

      // Log outgoing commission withdrawal
      await this.logPayment({
        type: 'outgoing',
        amount: withdrawAmount,
        fromNametag: config.agentNametag,
        toNametag: developerNametag,
        txId: transfer.transferId,
        purpose: 'commission_withdrawal',
        metadata: {
          previousBalance: balance.available,
          remainingBalance: balance.available - withdrawAmount,
        },
      });

      // eslint-disable-next-line no-console
      console.log(`[GameService] Commission withdrawal successful: ${transfer.transferId}`);

      return { success: true, amount: withdrawAmount, txId: transfer.transferId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      // eslint-disable-next-line no-console
      console.error(`[GameService] Commission withdrawal failed:`, error);
      return { success: false, amount: 0, error: message };
    }
  }
}
