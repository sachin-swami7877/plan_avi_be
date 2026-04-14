const User = require('../models/User');
const ReferralCommission = require('../models/ReferralCommission');

const COMMISSION_PCT = 3;

/**
 * Records a PENDING referral commission when User B (who used A's code) wins.
 * Commission = 3% of betAmount (entry fee).
 * The amount is NOT added to wallet yet — user must redeem it manually.
 * Non-fatal — logs errors but never throws.
 */
async function creditReferralCommission(winnerId, betAmount, matchId, matchType, io) {
  try {
    const winner = await User.findById(winnerId).select('referredBy name');
    if (!winner?.referredBy) return;

    const commissionAmount = Math.round(betAmount * COMMISSION_PCT) / 100;
    if (commissionAmount <= 0) return;

    const referrer = await User.findById(winner.referredBy).select('_id name');
    if (!referrer) return;

    await ReferralCommission.create({
      referrerId: referrer._id,
      referredUserId: winnerId,
      matchId,
      matchType,
      betAmount,
      commissionPct: COMMISSION_PCT,
      commissionAmount,
      status: 'pending',
    });

    // Real-time update — notify referrer's header instantly
    if (io) {
      // Fetch updated total for referrer
      const allComms = await ReferralCommission.find({ referrerId: referrer._id }).lean();
      const totalEarned = Math.round(allComms.reduce((s, c) => s + c.commissionAmount, 0) * 100) / 100;
      io.to(`user_${referrer._id}`).emit('referral:commission-updated', { totalEarned });
    }

    console.log(`[Referral] ₹${commissionAmount} pending for ${referrer.name} — ${winner.name}'s ₹${betAmount} win`);
  } catch (err) {
    console.error('[Referral] Commission error:', err.message);
  }
}

module.exports = { creditReferralCommission };
