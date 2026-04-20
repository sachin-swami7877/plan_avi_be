const User = require('../models/User');

async function awardReferralSpins(referrerId, newUserId) {
  try {
    const referrer = await User.findById(referrerId);
    if (!referrer) return null;

    // 1 referral = 1.5 spins added
    const spinsToAdd = 1.5;
    referrer.referralSpinsOffered = (referrer.referralSpinsOffered || 0) + spinsToAdd;
    await referrer.save();

    return referrer;
  } catch (err) {
    console.error('Award referral spins error:', err);
    return null;
  }
}

module.exports = { awardReferralSpins };
