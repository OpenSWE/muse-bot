// Gateway envelopes, typed from the descriptors the reference extracted from
// the muse.ai web bundle (src/data/desc*.bin, copied verbatim).
import { readFileSync } from "node:fs";
import {
  create,
  createFileRegistry,
  type DescMessage,
  fromBinary,
  toBinary,
} from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema, FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";

export const registry = createFileRegistry(
  create(FileDescriptorSetSchema, {
    file: [0, 1].map((i) =>
      fromBinary(
        FileDescriptorProtoSchema,
        readFileSync(new URL(`./data/desc${i}.bin`, import.meta.url)),
      ),
    ),
  }),
);

function schema(name: string): DescMessage {
  const desc = registry.getMessage(name);
  if (!desc) throw new Error(`protobuf descriptor missing ${name}`);
  return desc;
}

const NoiseTransportFrame = schema("ingress_rev_proxy.NoiseTransportFrame");
const ServiceRequest = schema("hatch.noise.ServiceRequest");
const ServiceResponse = schema("hatch.noise.ServiceResponse");
const ServiceFrame = schema("hatch.noise.ServiceFrame");

export interface ApplicationRequest {
  verb: string;
  path: string;
  headers: { key: string; value: string }[];
  body: Uint8Array;
  endBody: boolean;
}

export type FrameKind =
  | { case: "response"; value: { status: number; body: Uint8Array; endBody: boolean } }
  | { case: "bodyChunk"; value: { data: Uint8Array; endBody: boolean } }
  | { case: "reset"; value: { code: number; reason: string } }
  | { case: string | undefined; value?: unknown };

export interface Frame {
  streamId: number;
  kind: FrameKind;
}

// One request -> ServiceFrame -> ServiceRequest -> NoiseTransportFrame, ready to encrypt.
export function encodeRequest(
  service: number,
  streamId: number,
  request: ApplicationRequest,
): Uint8Array {
  const frame = create(ServiceFrame, { streamId, kind: { case: "request", value: request } });
  const outer = create(ServiceRequest, { service, payload: toBinary(ServiceFrame, frame) });
  const chunkId = new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer).getBigInt64(
    0,
    true,
  );
  const transport = create(NoiseTransportFrame, {
    chunkId,
    chunkIndex: 0,
    totalChunks: 1,
    payload: toBinary(ServiceRequest, outer),
  });
  return toBinary(NoiseTransportFrame, transport);
}

export function decodeFrame(plaintext: Uint8Array): Frame {
  const transport = fromBinary(NoiseTransportFrame, plaintext) as unknown as {
    payload: Uint8Array;
  };
  const outer = fromBinary(ServiceResponse, transport.payload) as unknown as {
    payload: Uint8Array;
  };
  return fromBinary(ServiceFrame, outer.payload) as unknown as Frame;
}
