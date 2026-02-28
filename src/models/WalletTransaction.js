const mongoose = require('mongoose');

const walletTransactionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    type: {
      type: String,
      enum: ['credit', 'debit'],
      required: true,
    },
    // What triggered this transaction
    category: {
      type: String,
      enum: [
        'deposit',           // deposit approved by admin (credit)
        'withdrawal',        // withdrawal requested (debit)
        'withdrawal_refund', // withdrawal rejected, refunded (credit)
        'game_bet',          // aviator bet placed (debit)
        'game_win',          // aviator cashout win (credit)
        'spin_cost',         // spinner play cost (debit)
        'spin_win',          // spinner win amount (credit)
        'ludo_entry',        // ludo match entry fee (debit)
        'ludo_win',          // ludo match win prize (credit)
        'ludo_refund',       // ludo match refunded (credit)
        'bonus',             // bonus claimed (credit)
        'admin_credit',      // admin manually added balance (credit)
        'admin_debit',       // admin manually subtracted balance (debit)
      ],
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    description: {
      type: String,
      default: '',
    },
    balanceBefore: {
      type: Number,
      required: true,
    },
    balanceAfter: {
      type: Number,
      required: true,
    },
    // Optional reference to related document (matchId, requestId, etc.)
    refId: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('WalletTransaction', walletTransactionSchema);
