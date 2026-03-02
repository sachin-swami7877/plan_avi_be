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
  walletBalance: {
    type: Number,
    default: 0
  },
  totalDeposited: {
    type: Number,
    default: 0
  },
  role: {
    type: String,
    enum: ['user', 'admin', 'manager'],
    default: 'user'
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
  }
}, {
  timestamps: true
});

// Keep role and isAdmin/isSubAdmin in sync
userSchema.pre('save', function (next) {
  if (this.isModified('role')) {
    this.isAdmin = this.role === 'admin';
    this.isSubAdmin = this.role === 'manager' || this.role === 'admin';
  } else if (this.isModified('isAdmin') || this.isModified('isSubAdmin')) {
    if (this.isAdmin) this.role = 'admin';
    else if (this.isSubAdmin) this.role = 'manager';
    else this.role = 'user';
  }
  next();
});

// Partial unique indexes — only index non-null values, so multiple null emails/phones are allowed
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });

module.exports = mongoose.model('User', userSchema);
