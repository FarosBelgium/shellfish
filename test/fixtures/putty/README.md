# PuTTY test keys

**Test-only keys. They grant access to nothing except the throwaway SSH servers the test suite starts.**

Generated with PuTTY's own `puttygen` 0.83, so the tests check Shellfish against real PuTTY output:

- `<type>-v2.ppk` / `<type>-v3.ppk`: PPK version 2 and 3, no passphrase
- `<type>-v2-enc.ppk` / `<type>-v3-enc.ppk`: the same key with passphrase `ppk-test-pass` (v3 uses Argon2id)
- `<type>.pub`: the public key (OpenSSH format)

Types: `ed25519`, `rsa` (2048), `ecdsa256`, `ecdsa384`.
