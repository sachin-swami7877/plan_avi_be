const mongoose = require('mongoose');

const kycRequestSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  email: { type: String, trim: true },
  aadhaarNumber: { type: String, trim: true },
  aadhaarFrontUrl: { type: String, default: null },
  address: { type: String, trim: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  rejectionReason: { type: String, default: '' },
  reviewedAt: { type: Date, default: null },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
}, { timestamps: true });

module.exports = mongoose.model('KycRequest', kycRequestSchema);
