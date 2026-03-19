const KycRequest = require('../models/KycRequest');
const User = require('../models/User');
const { uploadFromBuffer } = require('../config/cloudinary');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// POST /api/user/kyc — submit or resubmit KYC
const submitKyc = async (req, res) => {
  try {
    const { email, aadhaarNumber, address } = req.body;
    if (!email || !address) {
      return res.status(400).json({ message: 'Email and address are required' });
    }

    const userId = req.user._id;

    // Check if already approved
    if (req.user.kycStatus === 'approved') {
      return res.status(400).json({ message: 'KYC already approved' });
    }

    // Upload aadhaar front image
    let aadhaarFrontUrl = null;
    if (req.file) {
      try {
        const result = await uploadFromBuffer(req.file.buffer, {
          folder: 'kyc',
          public_id: `kyc_${userId}_${Date.now()}`,
        });
        aadhaarFrontUrl = result.secure_url;
      } catch (e) {
        return res.status(500).json({ message: 'Image upload failed. Please try again.' });
      }
    } else {
      // Check if existing request already has a photo
      const existing = await KycRequest.findOne({ userId });
      if (!existing?.aadhaarFrontUrl) {
        return res.status(400).json({ message: 'Aadhaar front photo is required' });
      }
      aadhaarFrontUrl = existing.aadhaarFrontUrl;
    }

    const kyc = await KycRequest.findOneAndUpdate(
      { userId },
      { email, aadhaarNumber: (aadhaarNumber || '').replace(/\s/g, ''), aadhaarFrontUrl, address, status: 'pending', rejectionReason: '', reviewedAt: null, reviewedBy: null },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await User.findByIdAndUpdate(userId, { kycStatus: 'pending' });

    res.json({ message: 'KYC submitted successfully. Awaiting admin review.', kyc });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// GET /api/user/kyc — get own KYC status
const getKycStatus = async (req, res) => {
  try {
    const kyc = await KycRequest.findOne({ userId: req.user._id }).lean();
    res.json({ kycStatus: req.user.kycStatus, kyc: kyc || null });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// GET /api/admin/kyc — list KYC requests
const getKycRequests = async (req, res) => {
  try {
    const { status, page = 1, limit = 30 } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    const skip = (Number(page) - 1) * Number(limit);
    const [requests, total] = await Promise.all([
      KycRequest.find(filter).populate('userId', 'name phone').sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      KycRequest.countDocuments(filter),
    ]);
    const pendingCount = await KycRequest.countDocuments({ status: 'pending' });
    res.json({ requests, total, totalPages: Math.ceil(total / Number(limit)), pendingCount });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// PUT /api/admin/kyc/:id/approve
const approveKyc = async (req, res) => {
  try {
    const kyc = await KycRequest.findByIdAndUpdate(
      req.params.id,
      { status: 'approved', rejectionReason: '', reviewedAt: new Date(), reviewedBy: req.user._id },
      { new: true }
    );
    if (!kyc) return res.status(404).json({ message: 'KYC request not found' });
    await User.findByIdAndUpdate(kyc.userId, { kycStatus: 'approved' });
    res.json({ message: 'KYC approved', kyc });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// PUT /api/admin/kyc/:id/reject
const rejectKyc = async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ message: 'Rejection reason is required' });
    const kyc = await KycRequest.findByIdAndUpdate(
      req.params.id,
      { status: 'rejected', rejectionReason: reason, reviewedAt: new Date(), reviewedBy: req.user._id },
      { new: true }
    );
    if (!kyc) return res.status(404).json({ message: 'KYC request not found' });
    await User.findByIdAndUpdate(kyc.userId, { kycStatus: 'rejected' });
    res.json({ message: 'KYC rejected', kyc });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = { submitKyc, getKycStatus, getKycRequests, approveKyc, rejectKyc, upload };
