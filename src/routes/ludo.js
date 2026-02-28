const express = require('express');
const router = express.Router();
const {
  createMatch,
  submitRoomCode,
  joinMatch,
  cancelMatch,
  checkMatchWaiting,
  getMyMatches,
  getMatchDetail,
  submitResult,
  submitLoss,
  cancelAsLoss,
  getLudoSettings,
  getWaitingList,
  getRunningBattles,
} = require('../controllers/ludoController');
const { protect } = require('../middleware/auth');
const upload = require('../middleware/upload');

router.use(protect);

router.post('/create', createMatch);
router.post('/submit-room-code', submitRoomCode);
router.post('/join', joinMatch);
router.post('/cancel', cancelMatch);
router.get('/match/:id/check', checkMatchWaiting);
router.get('/settings', getLudoSettings);
router.get('/my-matches', getMyMatches);
router.get('/match/:id', getMatchDetail);
router.post('/submit-result', upload.single('screenshot'), submitResult);
router.post('/submit-loss', submitLoss);
router.post('/cancel-as-loss', cancelAsLoss);
router.get('/waiting-list', getWaitingList);
router.get('/running-battles', getRunningBattles);

module.exports = router;
