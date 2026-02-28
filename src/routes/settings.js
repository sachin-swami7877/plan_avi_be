const express = require('express');
const router = express.Router();
const { getPublicSupport, getPublicTerms, getPublicLayout, getPublicUserWarning } = require('../controllers/adminController');

// Public routes (no auth required)
router.get('/support', getPublicSupport);
router.get('/terms', getPublicTerms);
router.get('/layout', getPublicLayout);
router.get('/user-warning', getPublicUserWarning);

module.exports = router;
