const express = require('express');
const router = express.Router();
const { 
  getGameState,
  placeBet,
  cashOut,
  getBetHistory,
  getRecentRounds,
  getCurrentBets
} = require('../controllers/gameController');
const { protect } = require('../middleware/auth');

router.get('/state', getGameState);
router.get('/rounds', getRecentRounds);
router.get('/current-bets', getCurrentBets);
router.post('/bet', protect, placeBet);
router.post('/cashout', protect, cashOut);
router.get('/history', protect, getBetHistory);

module.exports = router;
