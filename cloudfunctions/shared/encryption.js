const crypto = require('crypto');
const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

// 从环境变量获取密钥，若未设置则使用默认（生产环境必须设置ENCRYPTION_KEY环境变量）
function getKey() {
  const keyStr = process.env.ENCRYPTION_KEY || 'frxz-default-key-32-bytes-long!!';
  return Buffer.from(keyStr, 'utf8').slice(0, 32);
}

function encrypt(plaintext) {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return iv.toString('hex') + ':' + encrypted;
}

function decrypt(ciphertext) {
  if (!ciphertext) return '';
  const parts = ciphertext.split(':');
  if (parts.length !== 2) return '';
  const [ivHex, encrypted] = parts;
  try {
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (e) {
    console.error('Decrypt failed:', e.message);
    return '';
  }
}

module.exports = { encrypt, decrypt };
