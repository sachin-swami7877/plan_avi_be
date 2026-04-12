const express = require('express');
const router = express.Router();
const { getPublicSupport, getPublicTerms, getPublicLayout, getPublicUserWarning, getPublicLandingStats, getPublicAviatorStatus, getPublicLogo } = require('../controllers/adminController');

// Public routes (no auth required)
router.get('/support', getPublicSupport);
router.get('/terms', getPublicTerms);
router.get('/layout', getPublicLayout);
router.get('/user-warning', getPublicUserWarning);
router.get('/landing-stats', getPublicLandingStats);
router.get('/aviator-status', getPublicAviatorStatus);
router.get('/logo', getPublicLogo);

module.exports = router;
