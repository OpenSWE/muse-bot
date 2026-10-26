import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import { handshake, loadNoise, PROTOCOL } from "../src/noise.ts";
import { decodeFrame, encodeRequest, registry } from "../src/proto.ts";

const msg = (name: string) =>
  registry.getMessage(name) ??
  (() => {
    throw new Error(name);
  })();

it("completes an XX handshake with a noise-c responder and round-trips transport messages", async () => {
  const noise = await loadNoise();
  const responder = noise.HandshakeState(PROTOCOL, noise.constants.NOISE_ROLE_RESPONDER);
  responder.Initialize(null, noise.CreateKeyPair(noise.constants.NOISE_DH_CURVE25519)[0]);

  const toResponder: Uint8Array[] = [];
  let step = 0;
  const session = await handshake(
    (m) => {
      toResponder.push(m);
      if (step === 1) responder.ReadMessage(m);
    },
    async () => {
      responder.ReadMessage(toResponder[0]);
      step = 1;
      return responder.WriteMessage();
    },
  );
  // noise-c orients Split() per role: [send, receive].
  const [tx, rx] = responder.Split();
  const ad = new Uint8Array();

  const hello = new TextEncoder().encode("hello");
  expect(rx.DecryptWithAd(ad, session.encrypt(hello))).toEqual(hello);
  expect(session.decrypt(tx.EncryptWithAd(ad, hello))).toEqual(hello);
});

it("frames a request the way the gateway nests it", () => {
  const bytes = encodeRequest(2, 7, {
    verb: "GET",
    path: "/chat/history?limit=5",
    headers: [{ key: "x-request-id", value: "r1" }],
    body: new Uint8Array(),
    endBody: true,
  });
  const transport = fromBinary(msg("ingress_rev_proxy.NoiseTransportFrame"), bytes) as unknown as {
    totalChunks: number;
    payload: Uint8Array;
  };
  expect(transport.totalChunks).toBe(1);
  const outer = fromBinary(msg("hatch.noise.ServiceRequest"), transport.payload) as unknown as {
    service: number;
    payload: Uint8Array;
  };
  expect(outer.service).toBe(2);
  const frame = fromBinary(msg("hatch.noise.ServiceFrame"), outer.payload) as unknown as {
    streamId: unknown;
    kind: { case: string; value: { verb: string; path: string } };
  };
  expect(Number(frame.streamId)).toBe(7);
  expect(frame.kind.case).toBe("request");
  expect(frame.kind.value.path).toBe("/chat/history?limit=5");
});

it("decodes a response frame", () => {
  const Frame = msg("hatch.noise.ServiceFrame");
  const frame = create(Frame, {
    streamId: 3,
    kind: {
      case: "response",
      value: { status: 200, body: new TextEncoder().encode("{}"), endBody: true },
    },
  } as never);
  const outer = create(msg("hatch.noise.ServiceResponse"), {
    payload: toBinary(Frame, frame),
  } as never);
  const transport = create(msg("ingress_rev_proxy.NoiseTransportFrame"), {
    payload: toBinary(msg("hatch.noise.ServiceResponse"), outer),
  } as never);
  const f = decodeFrame(toBinary(msg("ingress_rev_proxy.NoiseTransportFrame"), transport));
  expect(Number(f.streamId)).toBe(3);
  expect(f.kind.case).toBe("response");
  expect((f.kind.value as { status: number }).status).toBe(200);
});
