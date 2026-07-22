/**
 * Diagnostic: find which SMSINDIAHUB sender ID is approved for this account.
 *
 * Usage (run on the server, inside ~/plan_avi_be):
 *   node scripts/testSenderId.js <10-digit-test-phone> <SENDERID1> [SENDERID2] ...
 *
 * Example:
 *   node scripts/testSenderId.js 7877722306 RSHKRO RKLUDO RUSHKR SMSHUB
 *
 * It sends a real OTP attempt with each candidate and prints the provider's
 * ErrorCode/ErrorMessage. ErrorCode "000" (or "0") => that sender ID works.
 */
require('dotenv').config();
const axios = require('axios');

const [, , phoneArg, ...senderIds] = process.argv;

if (!phoneArg || senderIds.length === 0) {
  console.error('Usage: node scripts/testSenderId.js <10-digit-phone> <SENDERID1> [SENDERID2] ...');
  process.exit(1);
}

const apiKey = process.env.SMSINDIAHUB_API_KEY;
if (!apiKey) {
  console.error('SMSINDIAHUB_API_KEY is not set in .env');
  process.exit(1);
}

const url = process.env.SMSINDIAHUB_URL || 'https://cloud.smsindiahub.in/api/mt/SendSMS';
const dltTemplateId = process.env.SMSINDIAHUB_DLT_TEMPLATE_ID || '1007801291964877107';
const peId = process.env.SMSINDIAHUB_PE_ID || '1701158019630577568';
const entityName = process.env.SMSINDIAHUB_ENTITY_NAME || 'RushkroLudo';

const cleanPhone = String(phoneArg).replace(/[^0-9]/g, '');
const fullNumber = cleanPhone.length === 10 ? `91${cleanPhone}` : cleanPhone;
const otp = '123456';
const message = `Welcome to the ${entityName} powered by SMSINDIAHUB. Your OTP for registration is ${otp}`;

async function tryOne(senderId) {
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
  try {
    const { data } = await axios.get(url, { params, timeout: 30000 });
    const code = data && (data.ErrorCode ?? data.errorCode);
    const ok = code === '000' || code === '0' || code === 0;
    console.log(`${ok ? '✅' : '❌'} ${senderId.padEnd(8)} -> ErrorCode=${code} | ${JSON.stringify(data)}`);
  } catch (err) {
    console.log(`⚠️  ${senderId.padEnd(8)} -> request failed: ${err.message}`);
  }
}

(async () => {
  console.log(`Testing ${senderIds.length} sender ID(s) against ${fullNumber}\n`);
  for (const id of senderIds) {
    await tryOne(id);
  }
  console.log('\nDone. The one with ✅ (ErrorCode 000) is your approved sender ID.');
})();
