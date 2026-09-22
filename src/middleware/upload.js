const multer = require('multer');
const path = require('path');

// Use memory storage so we can upload buffer to Cloudinary (no local file)
const storage = multer.memoryStorage();

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp|heic|heif/;
  const allowedMime = /jpeg|jpg|png|gif|webp|heic|heif|octet-stream/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedMime.test(file.mimetype);

  if (extname || mimetype) {
    return cb(null, true);
  }
  cb(new Error('Only image files are allowed (jpeg, jpg, png, gif, webp, heic)'));
};

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB (mobile photos can be large)
  fileFilter
});

/*
 * Every multer middleware is handed out already wrapped in keepSiteContext, so
 * routes keep calling upload.single(...) / upload.fields(...) unchanged and the
 * handler after the upload still runs against the right site's database.
 */
const { keepSiteContext } = require('./siteContext');

module.exports = {
  single: (...args) => keepSiteContext(upload.single(...args)),
  fields: (...args) => keepSiteContext(upload.fields(...args)),
  array: (...args) => keepSiteContext(upload.array(...args)),
  none: (...args) => keepSiteContext(upload.none(...args)),
  any: (...args) => keepSiteContext(upload.any(...args)),
};
