const mongoose = require('mongoose');

const referralCommissionSchema = new mongoose.Schema(
  {
    referrerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    referredUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    matchId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'LudoMatch',
      required: true,
    },
    matchType: {
      type: String,
      enum: ['ludo'],
      default: 'ludo',
    },
    betAmount: { type: Number, required: true },   // entry fee (bet) — commission is % of this
    commissionPct: { type: Number, default: 2 },
    commissionAmount: { type: Number, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ReferralCommission', referralCommissionSchema);
