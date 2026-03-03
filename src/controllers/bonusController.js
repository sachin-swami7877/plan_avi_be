const User = require('../models/User');
const AdminSettings = require('../models/AdminSettings');
const BonusRecord = require('../models/BonusRecord');
const WalletTransaction = require('../models/WalletTransaction');
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

    // Calculate today's deposit total from wallet transactions
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const todayDepositAgg = await WalletTransaction.aggregate([
      {
        $match: {
          userId: user._id,
          category: { $in: ['deposit', 'admin_credit'] },
          createdAt: { $gte: todayStart, $lte: todayEnd },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const todayDeposit = todayDepositAgg[0]?.total || 0;

    const claimed = user.bonusClaimed;

    // Milestones based on today's deposits
    const milestonesCrossed = Math.floor(todayDeposit / threshold);
    const bonusEarned = milestonesCrossed * cashback;

    // Check how much bonus was already claimed today
    const todayClaimAgg = await BonusRecord.aggregate([
      {
        $match: {
          userId: user._id,
          createdAt: { $gte: todayStart, $lte: todayEnd },
        },
      },
      { $group: { _id: null, total: { $sum: '$bonusAmount' } } },
    ]);
    const todayClaimed = todayClaimAgg[0]?.total || 0;

    const canClaim = bonusEarned > todayClaimed;
    const claimableAmount = Math.max(0, bonusEarned - todayClaimed);
    const progressToNext = todayDeposit % threshold;

    // Past records
    const history = await BonusRecord.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(50);

    res.json({
      todayDeposit,
      totalBets: todayDeposit,
      threshold,
      cashback,
      milestonesCrossed,
      bonusEarned,
      claimed: todayClaimed,
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

    // Calculate today's deposit total
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const todayDepositAgg = await WalletTransaction.aggregate([
      {
        $match: {
          userId: user._id,
          category: { $in: ['deposit', 'admin_credit'] },
          createdAt: { $gte: todayStart, $lte: todayEnd },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const todayDeposit = todayDepositAgg[0]?.total || 0;

    const milestonesCrossed = Math.floor(todayDeposit / threshold);
    const bonusEarned = milestonesCrossed * cashback;

    // How much was already claimed today
    const todayClaimAgg = await BonusRecord.aggregate([
      {
        $match: {
          userId: user._id,
          createdAt: { $gte: todayStart, $lte: todayEnd },
        },
      },
      { $group: { _id: null, total: { $sum: '$bonusAmount' } } },
    ]);
    const todayClaimed = todayClaimAgg[0]?.total || 0;

    const claimableAmount = Math.max(0, bonusEarned - todayClaimed);

    if (claimableAmount <= 0) {
      return res.status(400).json({ message: 'No bonus available to claim.' });
    }

    // Credit to wallet (earnings)
    const balBefore = user.walletBalance;
    user.creditEarnings(claimableAmount);
    user.bonusClaimed = (user.bonusClaimed || 0) + claimableAmount;
    user.lastBonusClaimedAt = new Date();
    await user.save();

    await recordWalletTx(
      user._id, 'credit', 'bonus', claimableAmount,
      `Bonus claimed — ₹${claimableAmount} credited (today's deposit: ₹${todayDeposit})`,
      balBefore, user.walletBalance
    );

    // Record
    await BonusRecord.create({
      userId: user._id,
      bonusAmount: claimableAmount,
      thresholdAmount: threshold,
      totalBetsAtClaim: todayDeposit,
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
