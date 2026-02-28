const User = require('../models/User');
const AdminSettings = require('../models/AdminSettings');
const BonusRecord = require('../models/BonusRecord');
const { recordWalletTx } = require('../utils/recordWalletTx');

// @desc    Get bonus status for current user
// @route   GET /api/bonus/status
const getBonusStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    let settings = await AdminSettings.findOne({ key: 'main' });
    if (!settings) settings = await AdminSettings.create({ key: 'main' });

    const threshold = settings.bonusMinBet;     // e.g. 1000
    const cashback = settings.bonusCashback;     // e.g. 100

    // How many times has the user crossed the threshold?
    const totalBets = user.totalBetAmount;
    const claimed = user.bonusClaimed;           // total bonus already credited

    // Next milestone: which multiple of threshold are we targeting?
    const milestonesCrossed = Math.floor(totalBets / threshold);
    const bonusEarned = milestonesCrossed * cashback;
    const canClaim = bonusEarned > claimed;
    const claimableAmount = bonusEarned - claimed;
    const progressToNext = totalBets % threshold;

    // Past records
    const history = await BonusRecord.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(50);

    res.json({
      totalBets,
      threshold,
      cashback,
      milestonesCrossed,
      bonusEarned,
      claimed,
      canClaim,
      claimableAmount,
      progressToNext,
      history,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Claim bonus
// @route   POST /api/bonus/claim
const claimBonus = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    let settings = await AdminSettings.findOne({ key: 'main' });
    if (!settings) settings = await AdminSettings.create({ key: 'main' });

    const threshold = settings.bonusMinBet;
    const cashback = settings.bonusCashback;

    const milestonesCrossed = Math.floor(user.totalBetAmount / threshold);
    const bonusEarned = milestonesCrossed * cashback;
    const claimableAmount = bonusEarned - user.bonusClaimed;

    if (claimableAmount <= 0) {
      return res.status(400).json({ message: 'No bonus available to claim.' });
    }

    // Credit to wallet
    const balBefore = user.walletBalance;
    user.walletBalance += claimableAmount;
    user.bonusClaimed = bonusEarned;
    user.lastBonusClaimedAt = new Date();
    await user.save();

    await recordWalletTx(
      user._id, 'credit', 'bonus', claimableAmount,
      `Bonus claimed — ₹${claimableAmount} credited`,
      balBefore, user.walletBalance
    );

    // Record
    await BonusRecord.create({
      userId: user._id,
      bonusAmount: claimableAmount,
      thresholdAmount: threshold,
      totalBetsAtClaim: user.totalBetAmount,
    });

    res.json({
      message: `₹${claimableAmount} bonus credited to your wallet!`,
      newBalance: user.walletBalance,
      claimableAmount: 0,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = { getBonusStatus, claimBonus };
