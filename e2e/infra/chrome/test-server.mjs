import { pbkdf2Sync } from "node:crypto";
import { writeFile } from "node:fs/promises";

import { PureCrypto } from "@bitwarden/sdk-internal";

const DEFAULT_SERVER = "https://localhost:8080";
const KDF_ITERATIONS = 600_000;

function localServer(value = DEFAULT_SERVER) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("The temporary test server must be an HTTP or HTTPS localhost origin.");
  return url.origin;
}

export async function waitForTestServer({ server = DEFAULT_SERVER, timeout = 60_000 } = {}) {
  const origin = localServer(server);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const [alive, configResponse] = await Promise.all([
        fetch(`${origin}/alive`, { signal: AbortSignal.timeout(3_000), redirect: "error" }),
        fetch(`${origin}/api/config`, { signal: AbortSignal.timeout(3_000), redirect: "error" }),
      ]);
      if (alive.ok && configResponse.ok) {
        const config = await configResponse.json();
        if (typeof config.version === "string")
          return {
            ready: true,
            aliveStatus: alive.status,
            configStatus: configResponse.status,
            version: config.version,
          };
      }
    } catch {
      // A fresh container may still be running database migrations.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The temporary Vaultwarden server did not become healthy in time.");
}

async function postJson(origin, pathname, body, responses) {
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  responses.push({ pathname, status: response.status });
  if (!response.ok) throw new Error("Temporary registration request was rejected.");
  return response;
}

// Keep the existing (page, account) contract. Account setup uses the server API;
// extension login, lock, inline Unlock and password keys still use the real UI.
export async function registerTemporaryAccount(
  _page,
  { server = DEFAULT_SERVER, email, password, name = "Chrome E2E" },
) {
  const origin = localServer(server);
  if (
    typeof email !== "string" ||
    !/^chrome-e2e-[a-z0-9-]+@example\.(?:invalid|test)$/i.test(email) ||
    typeof password !== "string" ||
    password.length < 20 ||
    typeof name !== "string" ||
    name.length > 50
  )
    throw new Error("Registration requires generated temporary credentials.");
  email = email.trim().toLowerCase();
  let stage = "server readiness";
  const responses = [];
  let userKey;
  let masterKey;
  let privateKey;
  try {
    await waitForTestServer({ server: origin });
    stage = "registration token request";
    const tokenResponse = await postJson(
      origin,
      "/identity/accounts/register/send-verification-email",
      { email, name },
      responses,
    );
    const token = await tokenResponse.json();
    if (typeof token !== "string" || !token)
      throw new Error("The temporary server must return a registration token directly.");

    stage = "V1 compatible account key generation";
    // SDK registration emits V2 accountKeys. Pinned Vaultwarden 1.37.5 instead
    // accepts V1 keys/userAsymmetricKeys. Generate its supported format using
    // the official SDK crypto primitives so asymmetric keys are preserved.
    // Contract: dani-garcia/vaultwarden@1.37.5/src/api/core/accounts.rs.
    const kdf = { pBKDF2: { iterations: KDF_ITERATIONS } };
    const encode = new TextEncoder();
    userKey = PureCrypto.make_user_key_aes256_cbc_hmac();
    const wrappedUserKey = PureCrypto.encrypt_user_key_with_master_password(
      userKey,
      password,
      email,
      kdf,
    );
    privateKey = PureCrypto.rsa_generate_keypair();
    const publicKey = PureCrypto.rsa_extract_public_key(privateKey);
    const encryptedPrivateKey = PureCrypto.symmetric_encrypt_bytes(privateKey, userKey);
    masterKey = PureCrypto.derive_kdf_material(encode.encode(password), encode.encode(email), kdf);
    // V1 server authentication hash: PBKDF2-SHA256 of the derived master key,
    // salted with the password, one iteration. Account KDF iterations are above.
    const authenticationHash = pbkdf2Sync(
      masterKey,
      Buffer.from(password),
      1,
      32,
      "sha256",
    ).toString("base64");

    stage = "V1 compatible account registration";
    const finishResponse = await postJson(
      origin,
      "/identity/accounts/register/finish",
      {
        email,
        emailVerificationToken: token,
        kdf: 0,
        kdfIterations: KDF_ITERATIONS,
        key: wrappedUserKey,
        masterPasswordHash: authenticationHash,
        keys: { publicKey: Buffer.from(publicKey).toString("base64"), encryptedPrivateKey },
      },
      responses,
    );
    if ((await finishResponse.json()).object !== "registerFinish")
      throw new Error("The temporary server did not confirm account registration.");
    return {
      registered: true,
      email,
      method: "vaultwarden-v1-api-with-official-sdk-crypto",
      signupUiTested: false,
      accountFormat: "V1",
      kdfIterations: KDF_ITERATIONS,
    };
  } catch {
    // SDK/fetch causes and response bodies can contain tokens, hashes or keys.
    // Preserve only public stage/status diagnostics.
    const diagnostics = {
      stage,
      origin,
      responses,
      method: "vaultwarden-v1-api-with-official-sdk-crypto",
    };
    await writeFile(
      "/artifacts/signup-diagnostics.json",
      JSON.stringify(diagnostics, null, 2) + "\n",
    ).catch(() => {});
    const error = new Error(
      `Temporary account setup failed during ${stage}; see signup-diagnostics.json.`,
    );
    error.signupDiagnostics = diagnostics;
    throw error;
  } finally {
    userKey?.fill(0);
    masterKey?.fill(0);
    privateKey?.fill(0);
  }
}
