import mongoose, { Document, Schema } from 'mongoose';

// Single bet within a round
export interface IBetItem {
  digit: number;
  amount: number;
}

// Bet document - one per user per round (can contain multiple digit bets)
export interface IBet extends Document {
  roundId: mongoose.Types.ObjectId;
  roundNumber: number;
  userNametag: string;
  bets: IBetItem[];
  totalAmount: number;
  invoiceId: string;
  paymentStatus: 'pending' | 'paid' | 'expired' | 'failed' | 'refunded';
  paymentTxId: string | null;
  refundTxId: string | null;
  refundReason: string | null;
  winnings: number;
  payoutStatus: 'none' | 'pending' | 'sent' | 'confirmed' | 'failed';
  payoutTxId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const betItemSchema = new Schema<IBetItem>(
  {
    digit: {
      type: Number,
      required: true,
      min: 0,
      max: 9,
    },
    amount: {
      type: Number,
      required: true,
      min: 1,
    },
  },
  { _id: false }
);

const betSchema = new Schema<IBet>(
  {
    roundId: {
      type: Schema.Types.ObjectId,
      ref: 'Round',
      required: true,
      index: true,
    },
    roundNumber: {
      type: Number,
      required: true,
      index: true,
    },
    userNametag: {
      type: String,
      required: true,
      index: true,
    },
    bets: {
      type: [betItemSchema],
      required: true,
      validate: [(v: IBetItem[]): boolean => v.length > 0, 'At least one bet required'],
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 1,
    },
    invoiceId: {
      type: String,
      required: true,
      unique: true,
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'expired', 'failed', 'refunded'],
      default: 'pending',
    },
    paymentTxId: {
      type: String,
      default: null,
    },
    refundTxId: {
      type: String,
      default: null,
    },
    refundReason: {
      type: String,
      default: null,
    },
    winnings: {
      type: Number,
      default: 0,
    },
    payoutStatus: {
      type: String,
      enum: ['none', 'pending', 'sent', 'confirmed', 'failed'],
      default: 'none',
    },
    payoutTxId: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for finding user bets in a round
betSchema.index({ roundId: 1, userNametag: 1 });

// Round document
export interface IRound extends Document {
  roundNumber: number;
  status: 'open' | 'closed' | 'drawing' | 'paying' | 'completed';
  winningDigit: number | null;
  totalPool: number;
  totalPayout: number;
  houseFee: number;
  startTime: Date;
  endTime: Date | null;
  drawTime: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const roundSchema = new Schema<IRound>(
  {
    roundNumber: {
      type: Number,
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ['open', 'closed', 'drawing', 'paying', 'completed'],
      default: 'open',
    },
    winningDigit: {
      type: Number,
      min: 0,
      max: 9,
      default: null,
    },
    totalPool: {
      type: Number,
      default: 0,
    },
    totalPayout: {
      type: Number,
      default: 0,
    },
    houseFee: {
      type: Number,
      default: 0,
    },
    startTime: {
      type: Date,
      default: Date.now,
    },
    endTime: {
      type: Date,
      default: null,
    },
    drawTime: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Commission tracking for developer withdrawals
export interface ICommission extends Document {
  totalAccumulated: number;
  totalWithdrawn: number;
  lastWithdrawalAt: Date | null;
  updatedAt: Date;
}

const commissionSchema = new Schema<ICommission>(
  {
    totalAccumulated: {
      type: Number,
      default: 0,
    },
    totalWithdrawn: {
      type: Number,
      default: 0,
    },
    lastWithdrawalAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

export const Bet = mongoose.model<IBet>('Bet', betSchema);
export const Round = mongoose.model<IRound>('Round', roundSchema);
export const Commission = mongoose.model<ICommission>('Commission', commissionSchema);
