// Noise_XX_25519_AESGCM_SHA256 initiator on noise-c (DECISIONS.md Q25), with empty
// payloads both ways as the gateway expects.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
export const PROTOCOL = "Noise_XX_25519_AESGCM_SHA256";

// Minimal surface of noise-c.wasm, which ships no types.
export interface CipherState {
  EncryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  DecryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
}
export interface HandshakeState {
  Initialize(prologue?: Uint8Array | null, s?: Uint8Array | null): void;
  WriteMessage(payload?: Uint8Array | null): Uint8Array;
  ReadMessage(message: Uint8Array, payloadNeeded?: boolean): Uint8Array | undefined;
  Split(): [CipherState, CipherState];
}
export interface NoiseLib {
  constants: Record<string, number>;
  HandshakeState(protocol: string, role: number): HandshakeState;
  CreateKeyPair(curve: number): [Uint8Array, Uint8Array];
}

let lib: Promise<NoiseLib> | undefined;

export function loadNoise(): Promise<NoiseLib> {
  lib ??= new Promise((resolve) => {
    const createNoise = require("noise-c.wasm");
    // Handing over the bytes skips Emscripten's fetch(), which fails on file paths and warns.
    const wasmBinary = readFileSync(require.resolve("noise-c.wasm/src/noise-c.wasm"));
    createNoise({ wasmBinary }, resolve);
  });
  return lib;
}

export interface Session {
  encrypt(plaintext: Uint8Array): Uint8Array;
  decrypt(ciphertext: Uint8Array): Uint8Array;
}

// Runs the three XX messages over `send`/`recv`, then returns the transport ciphers.
export async function handshake(
  send: (msg: Uint8Array) => void,
  recv: () => Promise<Uint8Array>,
): Promise<Session> {
  const noise = await loadNoise();
  const hs = noise.HandshakeState(PROTOCOL, noise.constants.NOISE_ROLE_INITIATOR);
  const [staticKey] = noise.CreateKeyPair(noise.constants.NOISE_DH_CURVE25519);
  hs.Initialize(null, staticKey);
  send(hs.WriteMessage());
  hs.ReadMessage(await recv());
  send(hs.WriteMessage());
  const [tx, rx] = hs.Split();
  const ad = new Uint8Array();
  return {
    encrypt: (pt) => tx.EncryptWithAd(ad, pt),
    decrypt: (ct) => rx.DecryptWithAd(ad, ct),
  };
}
