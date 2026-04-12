const User = require('../models/User');
const ReferralCommission = require('../models/ReferralCommission');
const { recordWalletTx } = require('./recordWalletTx');

const COMMISSION_PCT = 2;

/**
 * Credit referral commission to User A when User B (who used A's code) wins.
 * Commission = 2% of betAmount (entry fee), NOT of winAmount.
 * Non-fatal — logs errors but never throws.
 *
 * @param {string|ObjectId} winnerId   - User B (the winner)
 * @param {number} betAmount           - entry fee User B had placed (e.g. ₹1000)
 * @param {string|ObjectId} matchId
 * @param {string} matchType           - 'ludo'
 * @param {object|null} io             - Socket.io instance (optional)
 */
async function creditReferralCommission(winnerId, betAmount, matchId, matchType, io) {
  try {
    const winner = await User.findById(winnerId).select('referredBy name');
    if (!winner?.referredBy) return;

    const commissionAmount = Math.round(betAmount * COMMISSION_PCT) / 100;
    if (commissionAmount <= 0) return;

    const referrer = await User.findById(winner.referredBy);
    if (!referrer) return;

    const balBefore = referrer.walletBalance;
    referrer.creditEarnings(commissionAmount);
    await referrer.save();

    await ReferralCommission.create({
      referrerId: referrer._id,
      referredUserId: winnerId,
      matchId,
      matchType,
      betAmount,
      commissionPct: COMMISSION_PCT,
      commissionAmount,
    });

    await recordWalletTx(
      referrer._id, 'credit', 'referral_commission', commissionAmount,
      `Referral commission — ${winner.name || 'User'} ki ₹${betAmount} bet jeeti (${COMMISSION_PCT}%)`,
      balBefore, referrer.walletBalance, matchId
    );

    if (io) {
      io.to(`user_${referrer._id}`).emit('wallet:balance-updated', {
        walletBalance: referrer.walletBalance,
        depositBalance: referrer.depositBalance,
        earningsBalance: referrer.earningsBalance,
      });
    }

    console.log(`[Referral] ₹${commissionAmount} credited to ${referrer.name} for ${winner.name}'s ₹${betAmount} bet win`);
  } catch (err) {
    console.error('[Referral] Commission error:', err.message);
  }
}

module.exports = { creditReferralCommission };
