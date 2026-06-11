const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const sourcePath = path.join(root, 'campusride-8b0d9-firebase-adminsdk-fbsvc-ade361dfcb.json');
const targetPath = path.join(root, 'serviceAccountKey.json');
const envPath = path.join(root, '.env');

const raw = fs.readFileSync(sourcePath, 'utf8');
const firstBraceEnd = raw.indexOf('}') + 1;
const serviceAccount = JSON.parse(raw.slice(0, firstBraceEnd));

fs.writeFileSync(targetPath, JSON.stringify(serviceAccount, null, 2));
fs.writeFileSync(sourcePath, JSON.stringify(serviceAccount, null, 2));

let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

function setEnv(key, value) {
  const escaped =
    key === 'FIREBASE_PRIVATE_KEY'
      ? `"${value.replace(/\n/g, '\\n')}"`
      : value;
  const line = `${key}=${escaped}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  env = re.test(env) ? env.replace(re, line) : `${env.trimEnd()}\n${line}\n`;
}

setEnv('FIREBASE_PROJECT_ID', serviceAccount.project_id);
setEnv('FIREBASE_CLIENT_EMAIL', serviceAccount.client_email);
setEnv('FIREBASE_PRIVATE_KEY', serviceAccount.private_key);
setEnv('FIREBASE_CLIENT_ID', serviceAccount.client_id);
setEnv('FIREBASE_AUTH_URI', serviceAccount.auth_uri);
setEnv('FIREBASE_TOKEN_URI', serviceAccount.token_uri);
setEnv('FIREBASE_UNIVERSE_DOMAIN', serviceAccount.universe_domain);

fs.writeFileSync(envPath, env);

console.log('Firebase credentials connected.');
console.log(`project: ${serviceAccount.project_id}`);
console.log(`key id: ${serviceAccount.private_key_id}`);
