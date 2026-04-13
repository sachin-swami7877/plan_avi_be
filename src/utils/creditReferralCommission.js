const User = require('../models/User');
const ReferralCommission = require('../models/ReferralCommission');

const COMMISSION_PCT = 2;

/**
 * Records a PENDING referral commission when User B (who used A's code) wins.
 * Commission = 2% of betAmount (entry fee).
 * The amount is NOT added to wallet yet — user must redeem it manually.
 * Non-fatal — logs errors but never throws.
 */
async function creditReferralCommission(winnerId, betAmount, matchId, matchType) {
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

    console.log(`[Referral] ₹${commissionAmount} pending for ${referrer.name} — ${winner.name}'s ₹${betAmount} win`);
  } catch (err) {
    console.error('[Referral] Commission error:', err.message);
  }
}

module.exports = { creditReferralCommission };
