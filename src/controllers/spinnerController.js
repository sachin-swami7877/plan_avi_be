const User = require('../models/User');
const SpinnerRecord = require('../models/SpinnerRecord');
const { recordWalletTx } = require('../utils/recordWalletTx');

const VALID_SPIN_COSTS = [50, 100];

// Paid ₹50 spin outcomes
const OUTCOMES_50 = [
  { value: 'thank_you', weight: 53 },
  { value: '20', weight: 17 },
  { value: '50', weight: 17 },
  { value: '100', weight: 10 },
  { value: '120', weight: 3 },
];

// Paid ₹100 spin outcomes
const OUTCOMES_100 = [
  { value: 'thank_you', weight: 40 },
  { value: '20', weight: 14 },
  { value: '50', weight: 14 },
  { value: '100', weight: 17 },
  { value: '120', weight: 10 },
  { value: '170', weight: 4 },
  { value: '200', weight: 1 },
];

// FREE referral spinner outcomes: 60% empty, 22% ₹20, 5% ₹50, 2% ₹100, 1% ₹120
const OUTCOMES_REFERRAL = [
  { value: 'thank_you', weight: 60 },
  { value: '20', weight: 22 },
  { value: '50', weight: 5 },
  { value: '100', weight: 2 },
  { value: '120', weight: 1 },
];

// Big win thresholds — if user wins these, force next 1-2 spins to thank_you
const BIG_WIN_50 = ['100', '120'];       // ₹50 spin: ₹100 and ₹120 are big wins
const BIG_WIN_100 = ['170', '200'];       // ₹100 spin: ₹170 and ₹200 are big wins

// Per-user forced thank_you counter (in-memory, resets on server restart)
// Key: `${userId}_${spinCost}`, Value: remaining forced thank_you count
const forcedThankYou = new Map();

function getWeightedOutcome(outcomes) {
  const total = outcomes.reduce((s, o) => s + o.weight, 0);
  let r = Math.random() * total;
  for (const o of outcomes) {
    r -= o.weight;
    if (r <= 0) return o.value;
  }
  return 'thank_you';
}

// Round delay (ms) so response doesn't come instantly - spinner can sync with outcome
const SPIN_ROUND_DELAY_MS = 800;

// Helper function to play referral spinner logic
const playReferralSpinnerLogic = async (req, res, user) => {
  try {
    const spinCost = 50;
    const outcomes = OUTCOMES_REFERRAL;

    const userKey = `${user._id}_referral`;
    let outcome;

    const remaining = forcedThankYou.get(userKey) || 0;
    if (remaining > 0) {
      outcome = 'thank_you';
      forcedThankYou.set(userKey, remaining - 1);
      if (remaining - 1 <= 0) forcedThankYou.delete(userKey);
    } else {
      outcome = getWeightedOutcome(outcomes);
    }

    await new Promise((r) => setTimeout(r, SPIN_ROUND_DELAY_MS));
    const winAmount = outcome === 'thank_you' ? 0 : Number(outcome);

    const bigWins = ['100', '120', '170', '200'];
    if (bigWins.includes(outcome)) {
      const forceCount = Math.random() < 0.5 ? 1 : 2;
      forcedThankYou.set(userKey, forceCount);
    }

    const netChange = winAmount;
    const balBefore = user.walletBalance;

    const updated = await User.findOneAndUpdate(
      { _id: user._id, referralSpinsOffered: { $gte: 1 } },
      {
        $inc: {
          walletBalance: netChange,
          earningsBalance: netChange,
          referralSpinsOffered: -1,
          referralSpinsRedeemed: 1,
        }
      },
      { new: true }
    );

    if (!updated) {
      return res.status(400).json({ message: 'Failed to redeem referral spin. You may not have any spins left.' });
    }

    await SpinnerRecord.create({
      userId: user._id,
      outcome,
      winAmount,
      spinCost,
      spinType: 'referral',
      balanceAfter: updated.walletBalance,
    });

    if (winAmount > 0) {
      await recordWalletTx(
        user._id, 'credit', 'referral_spin_win', winAmount,
        `Referral spinner win — ₹${winAmount} credited`,
        balBefore, updated.walletBalance
      );
    }

    res.json({
      outcome,
      winAmount,
      newBalance: updated.walletBalance,
      referralSpinsRemaining: updated.referralSpinsOffered,
      message: outcome === 'thank_you' ? 'Thank you!' : `You won ₹${winAmount}!`,
    });
  } catch (error) {
    console.error('Referral spinner logic error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Play spinner (paid or free)
// @route   POST /api/spinner/play
const playSpinner = async (req, res) => {
  try {
    const spinType = req.body.type || 'paid'; // 'paid' or 'free'

    // Validate spin type
    if (!['paid', 'free'].includes(spinType)) {
      return res.status(400).json({ message: 'Invalid spin type. Must be "paid" or "free"' });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Handle FREE spin
    if (spinType === 'free') {
      // Validate free spins available
      if (!user.referralSpinsOffered || user.referralSpinsOffered < 1) {
        console.warn(`[SECURITY] User ${user._id} attempted free spin with no spins available: ${user.referralSpinsOffered}`);
        return res.status(400).json({ message: 'You do not have free spins. Earn them by referring friends!' });
      }
      return await playReferralSpinnerLogic(req, res, user);
    }

    // Handle PAID spin
    const spinCost = Number(req.body.spinCost) || 50;

    // Validate spin cost is integer and in valid range
    if (!Number.isInteger(spinCost) || !VALID_SPIN_COSTS.includes(spinCost)) {
      console.warn(`[SECURITY] User ${user._id} attempted invalid spin cost: ${spinCost}`);
      return res.status(400).json({ message: 'Invalid spin cost. Must be 50 or 100' });
    }

    // First validation: check balance before processing
    if (user.walletBalance < spinCost) {
      console.warn(`[SECURITY] User ${user._id} attempted spin with insufficient balance: ${user.walletBalance} < ${spinCost}`);
      return res.status(400).json({ message: `Minimum balance ₹${spinCost} required to spin` });
    }

    const userKey = `${user._id}_${spinCost}`;
    const outcomes = spinCost === 100 ? OUTCOMES_100 : OUTCOMES_50;
    let outcome;

    // Check if user has forced thank_you spins remaining
    const remaining = forcedThankYou.get(userKey) || 0;
    if (remaining > 0) {
      outcome = 'thank_you';
      forcedThankYou.set(userKey, remaining - 1);
      if (remaining - 1 <= 0) forcedThankYou.delete(userKey);
    } else {
      outcome = getWeightedOutcome(outcomes);
    }

    await new Promise((r) => setTimeout(r, SPIN_ROUND_DELAY_MS));
    const winAmount = outcome === 'thank_you' ? 0 : Number(outcome);

    // If this was a big win, force next 1-2 spins to thank_you for this user+cost
    const bigWins = spinCost === 100 ? BIG_WIN_100 : BIG_WIN_50;
    if (bigWins.includes(outcome)) {
      const forceCount = Math.random() < 0.5 ? 1 : 2; // random 1 or 2
      forcedThankYou.set(userKey, forceCount);
    }

    // Atomic balance update using $inc to prevent race conditions
    // (e.g. concurrent ludo refund + spinner play overwriting each other)
    const netChange = winAmount - spinCost; // e.g. win 100, cost 50 → net +50; win 0, cost 50 → net -50
    const balBefore = user.walletBalance;

    // Deduct from deposit first (same logic as smartDeduct), credit wins to earnings
    const fromDeposit = Math.min(user.depositBalance, spinCost);
    const fromEarnings = spinCost - fromDeposit;
    const incUpdate = {
      walletBalance: netChange,
      depositBalance: -fromDeposit,
      earningsBalance: -fromEarnings + winAmount,
    };

    const updated = await User.findOneAndUpdate(
      { _id: user._id, walletBalance: { $gte: spinCost } },
      { $inc: incUpdate },
      { new: true }
    );
    if (!updated) {
      // This can happen if: 1) Balance was just spent 2) Race condition 3) Fraud attempt
      const refreshedUser = await User.findById(user._id);
      console.warn(`[SECURITY] Spin failed for user ${user._id}. Balance check: ${refreshedUser.walletBalance} < ${spinCost}`);
      return res.status(400).json({ message: 'Insufficient balance. Please refresh and try again.' });
    }

    await SpinnerRecord.create({
      userId: user._id,
      outcome,
      winAmount,
      spinCost,
      balanceAfter: updated.walletBalance,
    });

    // Record spin cost debit
    await recordWalletTx(
      user._id, 'debit', 'spin_cost', spinCost,
      `Spinner play — ₹${spinCost} deducted`,
      balBefore, balBefore - spinCost
    );
    // Record win credit if any
    if (winAmount > 0) {
      await recordWalletTx(
        user._id, 'credit', 'spin_win', winAmount,
        `Spinner win — ₹${winAmount} credited`,
        balBefore - spinCost, updated.walletBalance
      );
    }

    res.json({
      outcome,
      winAmount,
      spinCost,
      newBalance: updated.walletBalance,
      message: outcome === 'thank_you' ? 'Thank you!' : `You won ₹${winAmount}!`,
    });
  } catch (error) {
    console.error('Spinner play error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Play referral spinner (free spins from referrals) — DEPRECATED, use /play with type: "free"
// @route   POST /api/spinner/play-referral
const playReferralSpinner = async (req, res) => {
  req.body.type = 'free';
  return playSpinner(req, res);
};

// @desc    Get referral spinner status
// @route   GET /api/spinner/referral-status
const getReferralStatus = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select(
      'referralSpinsOffered referralSpinsRedeemed'
    );
    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json({
      offered: user.referralSpinsOffered || 0,
      redeemed: user.referralSpinsRedeemed || 0,
      remaining: Math.floor(user.referralSpinsOffered || 0),
      fractional: ((user.referralSpinsOffered || 0) % 1).toFixed(1),
    });
  } catch (error) {
    console.error('Referral status error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get current user's spinner history (with pagination)
// @route   GET /api/spinner/history?page=1&limit=25
const getMyHistory = async (req, res) => {
  try {
    const { page = 1, limit = 25 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const filter = { userId: req.user._id };
    const [records, totalCount] = await Promise.all([
      SpinnerRecord.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      SpinnerRecord.countDocuments(filter)
    ]);

    res.json({
      records,
      totalCount,
      page: pageNum,
      totalPages: Math.ceil(totalCount / limitNum)
    });
  } catch (error) {
    console.error('Spinner history error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = { playSpinner, playReferralSpinner, getMyHistory, getReferralStatus };
