const User = require('../models/User');
const SpinnerRecord = require('../models/SpinnerRecord');
const { recordWalletTx } = require('../utils/recordWalletTx');

const SPIN_COST = 50;
const MIN_BALANCE = 50;

// Weighted outcomes for admin profit: most Thank you, never iPhone/MacBook
// thank_you 70%, 70 Rs 15%, 100 Rs 10%, 50 Rs 5%
const OUTCOMES = [
  { value: 'thank_you', weight: 70 },
  { value: '70', weight: 15 },
  { value: '100', weight: 10 },
  { value: '50', weight: 5 },
];

function getWeightedOutcome() {
  const total = OUTCOMES.reduce((s, o) => s + o.weight, 0);
  let r = Math.random() * total;
  for (const o of OUTCOMES) {
    r -= o.weight;
    if (r <= 0) return o.value;
  }
  return 'thank_you';
}

// Round delay (ms) so response doesn't come instantly - spinner can sync with outcome
const SPIN_ROUND_DELAY_MS = 800;

// @desc    Play spinner (cost 50, requires balance >= 50)
// @route   POST /api/spinner/play
const playSpinner = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (user.walletBalance < MIN_BALANCE) {
      return res.status(400).json({ message: `Minimum balance ₹${MIN_BALANCE} required to spin` });
    }

    const outcome = getWeightedOutcome();
    await new Promise((r) => setTimeout(r, SPIN_ROUND_DELAY_MS));
    const winAmount = outcome === 'thank_you' ? 0 : Number(outcome);

    // Pehle spin cost deduct, phir win amount add (e.g. 300 - 50 + 100 = 350)
    const balBefore = user.walletBalance;
    user.walletBalance = user.walletBalance - SPIN_COST + winAmount;
    await user.save();

    await SpinnerRecord.create({
      userId: user._id,
      outcome,
      winAmount,
      spinCost: SPIN_COST,
      balanceAfter: user.walletBalance,
    });

    // Record spin cost debit
    await recordWalletTx(
      user._id, 'debit', 'spin_cost', SPIN_COST,
      'Spinner play — ₹50 deducted',
      balBefore, balBefore - SPIN_COST
    );
    // Record win credit if any
    if (winAmount > 0) {
      await recordWalletTx(
        user._id, 'credit', 'spin_win', winAmount,
        `Spinner win — ₹${winAmount} credited`,
        balBefore - SPIN_COST, user.walletBalance
      );
    }

    res.json({
      outcome,
      winAmount,
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
