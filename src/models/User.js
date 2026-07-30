const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    default: null,
    trim: true
  },
  email: {
    type: String,
    default: null,
    trim: true,
    lowercase: true
  },
  phone: {
    type: String,
    default: null,
    trim: true
  },
  upiId: {
    type: String,
    default: null,
    trim: true
  },
  upiNumber: {
    type: String,
    default: null,
    trim: true
  },
  bankAccountNumber: {
    type: String,
    default: null,
    trim: true
  },
  bankIfscCode: {
    type: String,
    default: null,
    trim: true
  },
  bankAccountHolder: {
    type: String,
    default: null,
    trim: true
  },
  walletBalance: {
    type: Number,
    default: 0
  },
  depositBalance: {
    type: Number,
    default: 0
  },
  earningsBalance: {
    type: Number,
    default: 0
  },
  totalDeposited: {
    type: Number,
    default: 0
  },
  role: {
    type: String,
    enum: ['user', 'admin', 'manager', 'superadmin'],
    default: 'user'
  },
  isSuperAdmin: {
    type: Boolean,
    default: false
  },
  isAdmin: {
    type: Boolean,
    default: false
  },
  isSubAdmin: {
    type: Boolean,
    default: false
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'blocked'],
    default: 'active'
  },
  kycStatus: {
    type: String,
    enum: ['none', 'pending', 'approved', 'rejected'],
    default: 'none'
  },
  // Cumulative bonus tracking
  totalBetAmount: {
    type: Number,
    default: 0
  },
  bonusClaimed: {
    type: Number,
    default: 0
  },
  lastBonusClaimedAt: {
    type: Date,
    default: null
  },
  password: {
    type: String,
    default: null,
    select: false
  },
  otp: {
    type: String,
    default: null
  },
  otpExpiry: {
    type: Date,
    default: null
  },
  fcmTokens: {
    type: [String],
    default: []
  },
  // Single-device enforcement: only the most recent token is valid
  activeToken: {
    type: String,
    default: null,
    select: false
  },
  // Referral system
  referralCode: {
    type: String,
    unique: true,
    sparse: true,
    uppercase: true,
    index: true,
  },
  referredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  // Referral spinner system
  referralSpinsOffered: {
    type: Number,
    default: 0,
  },
  referralSpinsRedeemed: {
    type: Number,
    default: 0,
  },
  // Which website this account belongs to — same email/phone can exist once per site
  siteType: {
    type: String,
    enum: ['rushkroludo', '101dream'],
    default: 'rushkroludo',
    index: true,
  },
}, {
  timestamps: true
});

// Auto-generate unique referral code on first save
userSchema.pre('save', async function (next) {
  if (!this.referralCode) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code, exists;
    do {
      code = '';
      for (let i = 0; i < 7; i++) code += chars[Math.floor(Math.random() * chars.length)];
      exists = await this.constructor.findOne({ referralCode: code });
    } while (exists);
    this.referralCode = code;
  }
  next();
});

// Keep role and isAdmin/isSubAdmin/isSuperAdmin in sync
userSchema.pre('save', function (next) {
  if (this.isModified('role')) {
    this.isSuperAdmin = this.role === 'superadmin';
    this.isAdmin = this.role === 'admin' || this.role === 'superadmin';
    this.isSubAdmin = this.role === 'manager' || this.role === 'admin' || this.role === 'superadmin';
  } else if (this.isModified('isSuperAdmin') || this.isModified('isAdmin') || this.isModified('isSubAdmin')) {
    if (this.isSuperAdmin) this.role = 'superadmin';
    else if (this.isAdmin) this.role = 'admin';
    else if (this.isSubAdmin) this.role = 'manager';
    else this.role = 'user';
  }
  next();
});

// Balance helper methods — deposit first for bets, earnings first for withdrawals
userSchema.methods.smartDeduct = function (amount) {
  if (this.walletBalance < amount) throw new Error('Insufficient balance');
  const fromDeposit = Math.min(this.depositBalance, amount);
  const fromEarnings = amount - fromDeposit;
  this.depositBalance -= fromDeposit;
  this.earningsBalance -= fromEarnings;
  this.walletBalance -= amount;
  return { fromDeposit, fromEarnings };
};

userSchema.methods.smartDeductWithdrawal = function (amount) {
  if (this.walletBalance < amount) throw new Error('Insufficient balance');
  const fromEarnings = Math.min(this.earningsBalance, amount);
  const fromDeposit = amount - fromEarnings;
  this.earningsBalance -= fromEarnings;
  this.depositBalance -= fromDeposit;
  this.walletBalance -= amount;
};

userSchema.methods.creditDeposit = function (amount) {
  this.depositBalance += amount;
  this.walletBalance += amount;
};

userSchema.methods.creditEarnings = function (amount) {
  this.earningsBalance += amount;
  this.walletBalance += amount;
};

// Smart refund — credits back to deposit/earnings based on how it was originally deducted
userSchema.methods.smartRefund = function (amount, paidFromDeposit, paidFromEarnings) {
  if (paidFromDeposit != null && paidFromEarnings != null && (paidFromDeposit + paidFromEarnings) > 0) {
    // Refund proportionally based on original split
    const total = paidFromDeposit + paidFromEarnings;
    const refundToDeposit = Math.round((paidFromDeposit / total) * amount * 100) / 100;
    const refundToEarnings = amount - refundToDeposit;
    this.depositBalance += refundToDeposit;
    this.earningsBalance += refundToEarnings;
  } else {
    // Fallback: if no tracking info, credit to deposit (safe default)
    this.depositBalance += amount;
  }
  this.walletBalance += amount;
};

// Partial unique indexes — only index non-null values, so multiple null emails/phones are allowed.
// Compound with siteType: the same email/phone can have one account per website (rushkroludo + 101dream).
userSchema.index({ email: 1, siteType: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
userSchema.index({ phone: 1, siteType: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });

module.exports = mongoose.model('User', userSchema);
