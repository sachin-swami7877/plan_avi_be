const express = require('express');
const router = express.Router();
const { playSpinner, getMyHistory } = require('../controllers/spinnerController');
const { protect } = require('../middleware/auth');

router.post('/play', protect, playSpinner);
router.get('/history', protect, getMyHistory);

module.exports = router;
