const Bet = require('../models/Bet');
const GameRound = require('../models/GameRound');

// @desc    Get current game state
// @route   GET /api/game/state
const getGameState = async (req, res) => {
  try {
    const gameEngine = req.app.get('gameEngine');
    const state = gameEngine.getCurrentState();
    res.json(state);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Place a bet
// @route   POST /api/game/bet
const placeBet = async (req, res) => {
  try {
    const { amount } = req.body;
    
    if (!amount || amount < 10) {
      return res.status(400).json({ message: 'Minimum bet is Rs. 10' });
    }

    const gameEngine = req.app.get('gameEngine');
    const result = await gameEngine.placeBet(req.user._id, Number(amount));

    // Broadcast bet to all users
    const io = req.app.get('io');
    io.emit('bet:placed', {
      userName: req.user.name,
      amount
    });

    res.json({
      message: 'Bet placed successfully',
      bet: result.bet,
      newBalance: result.newBalance
    });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: error.message });
  }
};

// @desc    Cash out current bet
// @route   POST /api/game/cashout
const cashOut = async (req, res) => {
  try {
    const gameEngine = req.app.get('gameEngine');
    const result = await gameEngine.cashOut(req.user._id);

    // Broadcast cash out
    const io = req.app.get('io');
    io.emit('bet:cashout', {
      userName: req.user.name,
      multiplier: result.cashOutMultiplier,
      profit: result.profit
    });

    res.json({
      message: 'Cashed out successfully',
      ...result
    });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: error.message });
  }
};

// @desc    Get user's bet history
// @route   GET /api/game/history
const getBetHistory = async (req, res) => {
  try {
    const bets = await Bet.find({ userId: req.user._id })
      .populate('gameRoundId', 'roundId crashMultiplier')
      .sort({ createdAt: -1 })
      .limit(50);
    
    res.json(bets);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get recent game rounds
// @route   GET /api/game/rounds
const getRecentRounds = async (req, res) => {
  try {
    const rounds = await GameRound.find({ status: 'crashed' })
      .sort({ createdAt: -1 })
      .limit(20);
    
    res.json(rounds);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get current round's bets (for live display)
// @route   GET /api/game/current-bets
const getCurrentBets = async (req, res) => {
  try {
    const gameEngine = req.app.get('gameEngine');
    const state = gameEngine.getCurrentState();
    
    if (!state.round) {
      return res.json([]);
    }

    const bets = await Bet.find({ gameRoundId: state.round._id })
      .populate('userId', 'name')
      .sort({ createdAt: -1 });
    
    res.json(bets.map(bet => ({
      userName: bet.userId.name,
      amount: bet.amount,
      status: bet.status,
      cashOutMultiplier: bet.cashOutMultiplier,
      profit: bet.profit
    })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = {
  getGameState,
  placeBet,
  cashOut,
  getBetHistory,
  getRecentRounds,
  getCurrentBets
};
