const express = require('express');
const router = express.Router();
const { getPublicAppSettings, getPublicSupport, getPublicTerms, getPublicLayout, getPublicUserWarning, getPublicLandingStats, getPublicLogo } = require('../controllers/adminController');

// Public routes (no auth required)
router.get('/app', getPublicAppSettings);   // one call for logo + warning + youtube + support
router.get('/support', getPublicSupport);
router.get('/terms', getPublicTerms);
router.get('/layout', getPublicLayout);
router.get('/user-warning', getPublicUserWarning);
router.get('/landing-stats', getPublicLandingStats);
router.get('/aviator-status');
router.get('/logo', getPublicLogo);

module.exports = router;
