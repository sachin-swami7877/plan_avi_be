const mongoose = require('mongoose');

const adminSettingsSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    default: 'main',
  },
  // Payment QR & UPI
  qrCodeUrl: { type: String, default: null },
  upiId: { type: String, default: null },
  upiNumber: { type: String, default: null },
  // Support
  supportPhone: { type: String, default: null },
  supportWhatsApp: { type: String, default: null },
  // Bonus / Cashback
  bonusMinBet: { type: Number, default: 1000 },
  bonusCashback: { type: Number, default: 100 },
  // Terms & Conditions
  termsDeposit: { type: String, default: '' },
  termsWithdrawal: { type: String, default: '' },
  termsGeneral: { type: String, default: '' },
  // Dummy Users
  dummyUserCount: { type: Number, default: 10 },
  // Landing Page Layout
  layout: { type: Boolean, default: false },
  // Landing Page Stats (displayed on landing page stats bar)
  landingPlayers: { type: String, default: '1000+' },
  landingWonToday: { type: String, default: '₹1K+' },
  // User Warning (shown on dashboard)
  userWarning: { type: String, default: '' },
  // Ludo: number of dummy running battles to show on user app (frontend generates them)
  ludoDummyRunningBattles: { type: Number, default: 15, min: 0, max: 50 },
  // Bets toggle (persisted so it survives server restarts)
  betsEnabled: { type: Boolean, default: true },
  // Withdrawal toggle
  withdrawalsEnabled: { type: Boolean, default: true },
  withdrawalDisableReason: { type: String, default: '' },
  // Ludo: enable/disable new matches
  ludoEnabled: { type: Boolean, default: true },
  ludoDisableReason: { type: String, default: '' },
  ludoWarning: { type: String, default: '' },
  // Ludo: tiered commission structure
  // Tier 1: entry <= ludoCommTier1Max => ludoCommTier1Pct % commission
  ludoCommTier1Max: { type: Number, default: 250 },
  ludoCommTier1Pct: { type: Number, default: 10 },
  // Tier 2: entry > tier1Max && entry <= ludoCommTier2Max => ludoCommTier2Pct % commission
  ludoCommTier2Max: { type: Number, default: 600 },
  ludoCommTier2Pct: { type: Number, default: 8 },
  // Tier 3: entry > tier2Max => ludoCommTier3Pct % commission
  ludoCommTier3Pct: { type: Number, default: 5 },
}, {
  timestamps: true,
});

module.exports = mongoose.model('AdminSettings', adminSettingsSchema);
