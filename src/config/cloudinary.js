const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

/**
 * Upload a file buffer to Cloudinary
 * @param {Buffer} buffer - File buffer from multer
 * @param {string} [folder='lean_aviator'] - Cloudinary folder
 * @param {string} [mimetype='image/jpeg'] - MIME type for data URI
 * @returns {Promise<string>} Secure URL of uploaded image
 */
const uploadFromBuffer = (buffer, folder = 'lean_aviator', mimetype = 'image/jpeg') => {
  return new Promise((resolve, reject) => {
    const dataUri = `data:${mimetype};base64,${buffer.toString('base64')}`;
    cloudinary.uploader.upload(dataUri, {
      folder,
      resource_type: 'image'
    }, (err, result) => {
      if (err) return reject(err);
      resolve(result.secure_url);
    });
  });
};

module.exports = { cloudinary, uploadFromBuffer };
