const express = require('express');
const router = express.Router();
const { playSpinner, playReferralSpinner, getMyHistory, getReferralStatus } = require('../controllers/spinnerController');
const { protect } = require('../middleware/auth');

router.post('/play', protect, playSpinner);
router.post('/play-referral', protect, playReferralSpinner);
router.get('/referral-status', protect, getReferralStatus);
router.get('/history', protect, getMyHistory);

module.exports = router;
