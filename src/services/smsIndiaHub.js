const axios = require('axios');

/**
 * Send OTP SMS via SMSINDIAHUB
 *
 * Env:
 * - SMSINDIAHUB_API_KEY (required)
 * - SMSINDIAHUB_SENDER_ID (optional, default: SMSHUB)
 * - SMSINDIAHUB_DLT_TEMPLATE_ID (optional, default from provided API)
 * - SMSINDIAHUB_PE_ID (optional, default from provided API)
 * - SMSINDIAHUB_ENTITY_NAME (optional, entity name in DLT template)
 * - SMSINDIAHUB_URL (optional, override endpoint)
 */
async function sendOtpSms(phone, otp) {
  const apiKey = process.env.SMSINDIAHUB_API_KEY;
  if (!apiKey) {
    throw new Error('SMSINDIAHUB_API_KEY is not configured');
  }

  const senderId = process.env.SMSINDIAHUB_SENDER_ID || 'SMSHUB';
  const url = process.env.SMSINDIAHUB_URL || 'https://cloud.smsindiahub.in/api/mt/SendSMS';
  const dltTemplateId = process.env.SMSINDIAHUB_DLT_TEMPLATE_ID || '1007801291964877107';
  const peId = process.env.SMSINDIAHUB_PE_ID || '1701158019630577568';
  const entityName = process.env.SMSINDIAHUB_ENTITY_NAME || 'RushkroLudo';

  const cleanPhone = String(phone || '').replace(/[^0-9]/g, '');
  if (!cleanPhone || cleanPhone.length < 10) {
    throw new Error('Invalid phone number for SMS');
  }

  // Ensure 91 country code prefix for India
  const fullNumber = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;

  const message = `Welcome to the ${entityName} powered by SMSINDIAHUB. Your OTP for registration is ${otp}`;

  const params = {
    APIKey: apiKey,
    senderid: senderId,
    channel: 'Trans',
    DCS: 0,
    flashsms: 0,
    number: fullNumber,
    text: message,
    DLTTemplateId: dltTemplateId,
    route: 0,
    PEId: peId,
  };

  const response = await axios.get(url, { params, timeout: 10000 });
  console.log('SMSINDIAHUB response:', response.data);
  return response.data;
}

module.exports = { sendOtpSms };

