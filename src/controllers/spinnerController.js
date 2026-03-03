const User = require('../models/User');
const SpinnerRecord = require('../models/SpinnerRecord');
const { recordWalletTx } = require('../utils/recordWalletTx');

const VALID_SPIN_COSTS = [50, 100];

// ₹50 spin outcomes: thank_you 53%, ₹50 17%, ₹70 13%, ₹100 10%, ₹120 3%
// Expected payout = 31.2, profit = ₹18.8 (37.6%)
const OUTCOMES_50 = [
  { value: 'thank_you', weight: 53 },
  { value: '50', weight: 17 },
  { value: '70', weight: 13 },
  { value: '100', weight: 10 },
  { value: '120', weight: 3 },
];

// ₹100 spin outcomes: thank_you 40%, ₹50 14%, ₹100 17%, ₹120 14%, ₹170 10%, ₹200 5%
// Expected payout = 67.8, profit = ₹32.2 (32.2%)
const OUTCOMES_100 = [
  { value: 'thank_you', weight: 40 },
  { value: '50', weight: 14 },
  { value: '100', weight: 17 },
  { value: '120', weight: 14 },
  { value: '170', weight: 10 },
  { value: '200', weight: 5 },
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

// @desc    Play spinner (cost 50 or 100)
// @route   POST /api/spinner/play
const playSpinner = async (req, res) => {
  try {
    const spinCost = Number(req.body.spinCost) || 50;
    if (!VALID_SPIN_COSTS.includes(spinCost)) {
      return res.status(400).json({ message: 'Invalid spin cost' });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (user.walletBalance < spinCost) {
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

    // Pehle spin cost deduct, phir win amount add
    const balBefore = user.walletBalance;
    user.smartDeduct(spinCost);
    if (winAmount > 0) user.creditEarnings(winAmount);
    await user.save();

    await SpinnerRecord.create({
      userId: user._id,
      outcome,
      winAmount,
      spinCost,
      balanceAfter: user.walletBalance,
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
        balBefore - spinCost, user.walletBalance
      );
    }

    res.json({
      outcome,
      winAmount,
      spinCost,
      newBalance: user.walletBalance,
      message: outcome === 'thank_you' ? 'Thank you!' : `You won ₹${winAmount}!`,
    });
  } catch (error) {
    console.error('Spinner play error:', error);
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

module.exports = { playSpinner, getMyHistory };
