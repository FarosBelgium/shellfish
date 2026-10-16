// Checks that PuTTY keys (.ppk v3 with Argon2) can be read inside a packaged build, where
// the Argon2 fallback (@noble/hashes, an ES module) is loaded from app.asar.
//   ELECTRON_RUN_AS_NODE=1 <app executable> test/packaged-ppk-test.js <resources dir>
const fs = require('fs');
const path = require('path');

const ppk = require(path.resolve(process.argv[2], 'app.asar', 'src', 'main', 'ppk.js'));
const fixture = path.join(__dirname, 'fixtures', 'putty', 'ed25519-v3-enc.ppk');
ppk.ppkToOpenSsh(fs.readFileSync(fixture, 'utf8'), 'ppk-test-pass').then(
  (pem) => {
    const ok = pem.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----');
    console.log(ok ? `PASS: PuTTY keys work in the packaged ${process.platform} app` : 'FAIL: unexpected output');
    process.exit(ok ? 0 : 1);
  },
  (e) => { console.log(`FAIL: ${e.message}`); process.exit(1); },
);
