const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const bcrypt = require('../backend/node_modules/bcryptjs');
const root = path.resolve(__dirname, '..');
const local = path.join(root, '.local');
fs.mkdirSync(local, { recursive: true, mode: 0o700 });
const accountsFile = path.join(local, 'test-accounts.json');
const accounts = fs.existsSync(accountsFile) ? JSON.parse(fs.readFileSync(accountsFile, 'utf8')) : {
  admin: { email: 'admin@example.test', password: crypto.randomBytes(18).toString('base64url') },
  alex: { email: 'alex@example.test', password: crypto.randomBytes(18).toString('base64url') },
  maya: { email: 'maya@example.test', password: crypto.randomBytes(18).toString('base64url') },
};
fs.writeFileSync(accountsFile, JSON.stringify(accounts, null, 2) + '\n', { mode: 0o600 });
function writeOnce(relative, contents) {
  const filename = path.join(root, relative);
  if (fs.existsSync(filename)) { console.log(`Preserved ${relative}`); return; }
  fs.writeFileSync(filename, contents, { mode: 0o600 });
  console.log(`Created ${relative}`);
}
writeOnce('backend/.env.test.local', `NODE_ENV=development
PORT=4000
MONGODB_URI=mongodb://127.0.0.1:27017/unichat_local_test
JWT_SECRET=${crypto.randomBytes(48).toString('hex')}
JWT_REFRESH_SECRET=${crypto.randomBytes(48).toString('hex')}
PASSWORD_RESET_PEPPER=${crypto.randomBytes(48).toString('hex')}
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
CLIENT_URL=http://localhost:5173
ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
PUBLIC_API_URL=http://localhost:4000/api
TRUST_PROXY_HOPS=0
ALLOWED_REGISTRATION_DOMAIN=
AUTO_JOIN_DEFAULT_WORKSPACE=false
WORKSPACE_CREATION=members
REQUIRE_EMAIL_VERIFICATION=true
PASSWORD_RECOVERY_MODE=email
EMAIL_TRANSPORT=file
DEV_EMAIL_DIR=../.local/mail
FILE_STORAGE=local
LOCAL_UPLOAD_DIR=../.local/uploads
ADMIN_EMAIL=${accounts.admin.email}
ADMIN_PASSWORD_HASH='${bcrypt.hashSync(accounts.admin.password, 12)}'
GOOGLE_WEB_CLIENT_ID=
GOOGLE_CLIENT_IDS=
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=Unichat <no-reply@example.test>
CLOUDINARY_CLOUD_NAME=
CLOUDINARY_API_KEY=
CLOUDINARY_API_SECRET=
REDIS_URL=
WEB_PUSH_PUBLIC_KEY=
WEB_PUSH_PRIVATE_KEY=
WEB_PUSH_SUBJECT=mailto:admin@example.test
EXPO_ACCESS_TOKEN=
RECOVERY_APPROVAL_URL=http://localhost:5173/recovery/approve
`);
writeOnce('web/.env.test.local', `VITE_API_URL=http://localhost:4000/api\nVITE_SOCKET_URL=http://localhost:4000\n`);
console.log('Local settings are ready. Test account credentials: .local/test-accounts.json');
console.log('Run npm run seed:local, then npm run dev. Verification emails appear in .local/mail/.');
