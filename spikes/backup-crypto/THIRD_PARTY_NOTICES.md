# G016 Quick Crypto third-party evidence

This inventory is scoped to the selected G016 native stack. Exact npm identities come from the committed local `package-lock.json`; retained grants/notices live in `third-party-licenses/`. Run `npm run check:licenses` after `npm ci`. The checker validates every version, registry integrity, retained-file SHA-256, Quick Crypto’s exact six-package runtime dependency set, bundled-source license copies, and native OpenSSL coordinates.

## Selected native/config packages and Quick Crypto runtime JS dependencies

| Package identity | Registry integrity | Retained grant (SHA-256) |
|---|---|---|
| `react-native-quick-crypto@1.1.6` | `sha512-FPq628/KjdwUCtKEMzbNDXiw+Z1DM6tBcQnUu/qtLtiGsIFNebrCMTpCjry0T3hhDcGbd9IC4acHxprAteh8rA==` | `react-native-quick-crypto-MIT.txt` — `23a40842fe81de8bb8046e58abc393c2eb6b364989d7c5834cbd420be38ffbb7` (upstream tag `v1.1.6`; npm tarball omits the top-level file) |
| `react-native-nitro-modules@0.36.1` | `sha512-kBv/VvKqAmkXAvP1DxJMC9b/fRhh7JdSO4EUnPP46hJjrIFeFR8AwKm8mYaKZEuF014M/TVdv2vomVUW0umsQQ==` | `react-native-nitro-modules-MIT.txt` — `833ee7046f3908173364391ad4a2028560029503faf3a29e8acb77506dfe52ea` (upstream tag `v0.36.1`; npm tarball omits the top-level file) |
| `react-native-quick-base64@3.0.1` | `sha512-EjUP2U7WqKmlMmoY7XGyHomy8bM0q4+yCDCRg4ZezQ6zedYRwc7yVk4V2O/iSftKaLEzhuW98lpyPMdk1iPHXQ==` | `react-native-quick-base64-MIT.txt` — `cce0924a5108e418fdab4317777387e8fbeaf4abfae06d66fbb4314fba3bbcb8` |
| `expo-build-properties@57.0.3` | `sha512-oiqyD583acVmFVdF5nPSYEI7B/1ulOfIJhmfhr3bT51/64jtwaY0FzgVL8C2o23Z+CvCnEL8gOnhtH0sqcRWiA==` | `expo-build-properties-MIT.txt` — `fb3ca4a837f5779e83cef89b78253a8949cfb9429c340309f62d0465ec6610b4` |
| `expo-crypto@57.0.0` | `sha512-vd0kdUO14h9CgPcgzcR8nmy/wgz3zSOhQmucnbDdyn/z9eAeR2IB5BKaDvPbg/lrIT+KweGAV5IlrK5PZFqUSQ==` | `expo-crypto-MIT.txt` — `fb3ca4a837f5779e83cef89b78253a8949cfb9429c340309f62d0465ec6610b4` |
| `@craftzdog/react-native-buffer@6.1.2` | `sha512-KV1HitN05FHLLDG7Zb/yftDsa+mKBYBzFMQ0PMldvUicq6vWOtAvz9mDavt7Fzozh+WNqORE+yFDkkdWysZ/SA==` | `craftzdog-react-native-buffer-MIT.txt` — `ed2e878b5cbcda860c7640ce99838e3d83d7cf5e8ad31fc57c11f313b685ae00` |
| `events@3.3.0` | `sha512-mQw+2fkQbALzQ7V0MY0IqdnXNOeTtP4r0lN9z7AAawCXgqea7bDii20AYrIBrFd/Hx0M2Ocz6S111CaFkUcb0Q==` | `events-MIT.txt` — `631987b7616a325a5b97566c232418481ddf7dbb5ecadefb991e791876cc2599` |
| `readable-stream@4.7.0` | `sha512-oIGGmcpTLwPga8Bn6/Z75SVaH1z5dUut2ibSyAMVhmUggWpmDn2dapB0n7f8nwaSiRtepAsfJyfXIO5DCVAODg==` | `readable-stream-MIT.txt` — `ec62dc96da0099b87f4511736c87309335527fb7031639493e06c95728dc8c54` |
| `safe-buffer@5.2.1` | `sha512-rp3So07KcdmmKbGvgaNxQSJr7bGVSVk5S9Eq1F+ppbRo70+YeaDxkw5Dd8NPN+GD6bjnYm2VuPuCXmpuYvmCXQ==` | `safe-buffer-MIT.txt` — `c7cc929b57080f4b9d0c6cf57669f0463fc5b39906344dfc8d3bc43426b30eac` |
| `string_decoder@1.3.0` | `sha512-hkRX8U1WjJFd8LsDJ2yQ/wWWxaopEsABU1XfkM8A+j0+85JAGppt16cr1Whg6KIbb4okU6Mql6BOj+uup/wKeA==` | `string_decoder-MIT.txt` — `11f2aafb37d06b3ee5bdaf06e9811141d0da05263c316f3d627f45c20d43261b` |
| `util@0.12.5` | `sha512-kZf/K6hEIrWHI6XqOFUiiMa+79wE/D8Q+NCNAWclkyg3b4d2k7s0QGepNjiABc+aR3N1PAyHL7p6UcLY6LmrnA==` | `util-MIT.txt` — `6239c6144c31e58cf925c34483606969c555574d64ffa96518ab5d7f45c75d43` |

The last six rows are the complete runtime dependency set declared by `react-native-quick-crypto@1.1.6`: `@craftzdog/react-native-buffer`, `events`, `readable-stream`, `safe-buffer`, `string_decoder`, and `util`. Their transitive dependencies remain represented by the npm lock and installed-package license files; this G016 gate specifically binds the six direct runtime identities selected by Quick Crypto.

## Native OpenSSL resolution

Quick Crypto declares Android `io.github.ronickg:openssl:3.6.2-1` and iOS `OpenSSL-Universal ~> 3.6.2000`. OpenSSL 3.6.2’s Apache-2.0 grant is retained as `openssl-Apache-2.0.txt` — `7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a`; its acknowledgements are retained as `openssl-ACKNOWLEDGEMENTS.md` — `58dee45791f007ced048114717f86672778fe75c551827c57e760861446ce3c3`. The machine check verifies both coordinates against the installed Quick Crypto `build.gradle`/podspec. npm audit does not inspect either native binary.

## Source bundled inside `react-native-quick-crypto@1.1.6`

These files are copied byte-for-byte from the locked Quick Crypto tarball unless noted. Dual/multi-license choices are retained rather than collapsed.

| Bundled material | Retained grant/notice (SHA-256) |
|---|---|
| ncrypto | `ncrypto-MIT.txt` — `6b44642e301e561e683a3874ac3c300780fd18f851191f988d12a144d0d482f7` |
| simdutf MIT option | `simdutf-MIT.txt` — `fc8dbc04e03ad4efc08a647ffe7f995b811a95bc04c0e85a56d5277c6593fa5f` |
| simdutf Apache-2.0 option | `simdutf-Apache-2.0.txt` — `3d34610fc6b5e1b0bfe4e2f36171c2d62c28ef05cb8d704f5a0073be41a43b3d` |
| BLAKE3 Apache-2.0 | `blake3-Apache-2.0.txt` — `00fcc7a934ddbc9ece2a7cc063ac788e284b703b1d705ccbba72d462aa97921e` |
| BLAKE3 Apache-2.0 + LLVM exception | `blake3-Apache-2.0-LLVM-exception.txt` — `a5695f57ea0c221e0e8b7d784ff774c35e88c3d3270353646a925880bb3492cc` |
| BLAKE3 CC0-1.0 option | `blake3-CC0-1.0.txt` — `a2010f343487d3f7618affe54f789f5487602331c0a8d03f49e9a7c547cf0499` |
| fast-pbkdf2 CC0 dedication notice | `fastpbkdf2-CC0-notice.txt` — `5c6a682c677b94448e41ba048a740f604b8638254ae9090c40aedd443ff67126` (full CC0 legal text is retained in `blake3-CC0-1.0.txt`) |
| bundled C++ base64 notice | `quick-crypto-base64-notice.txt` — `0c3b60e3c1a56e073cc4b0fdeae2efe5fbddb9b968754f695fd4337fa350e4c5` |

## Required caveats

- Quick Crypto has no published independent audit report. OpenSSL and upstream tests do not constitute an independent audit of the TypeScript/JSI/C++ integration.
- Package-root import may install only the documented function-valued `global.process.nextTick = setImmediate` fallback when absent. G016 never calls `install()`, never aliases `crypto`, and never assigns `global.crypto` or `global.Buffer`.
- Best-effort wiping cannot guarantee erasure of VM, JSI, OpenSSL, or garbage-collected copies.
- The compiled native API surface is much broader than G016’s scrypt/SHA-256/AES-GCM use.
- The inherited Expo/config audit chain retains 11 moderate findings; a breaking `npm audit fix --force` is not approved.
- Noble remains rejected and absent from this package and lock.
- License completeness is not device approval. Final G016 device PASS belongs only to `deviceEvidenceValidator.mjs`; physical-iOS Release remains a later production gate.
