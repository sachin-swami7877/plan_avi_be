const express = require('express');
const router = express.Router();
const { getBonusStatus, claimBonus } = require('../controllers/bonusController');
const { protect } = require('../middleware/auth');

router.get('/status', protect, getBonusStatus);
router.post('/claim', protect, claimBonus);

module.exports = router;
