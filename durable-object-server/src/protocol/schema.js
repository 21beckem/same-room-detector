// protocol/schema.js
//
// The ONE file you edit to change the wire protocol. It is imported by both the
// frontend and the Durable Object, so they can never disagree.
//
// Wire format of a normal packet:
//   byte 0   : version (high 4 bits) | flags (low 4 bits: request, response, error, chunk)
//   byte 1   : message type id
//   2 bytes  : request id (u16)   -- ONLY when it is a request or a response
//   fields   : in the order listed below, no names, no padding
//   payload  : (only if `payload: true`) everything left in the packet, so no length field
//
// Field types:
//   u8 u16 u32 i8 i16 i32 f32 f64   fixed-size numbers (little-endian)
//   uvar                            unsigned varint: 1 byte for 0..127, 2 for ..16383, etc.
//   bool                            1 byte
//   ts                              absolute ms timestamp, sent as 4 bytes relative to the
//                                   connection's base time (auto-filled with "now" if omitted)
//   uid                             u32 client id (0 is reserved for "the server")
//   str                             UTF-8 string, varint length prefix (1 byte for short ones)
//   json                            any JSON value, varint length prefix
//   bytes                           binary blob, varint length prefix
//   'bytes(16)'                     binary blob of exactly 16 bytes, no length prefix
//   { flags: ['a', 'b', 'c'] }      bit-packed booleans -> { a: true, b: false, c: true }
//
// Rules:
//   - message ids must be 1..239 and unique (240..255 are reserved for built-ins like `hello`)
//   - `reply: 'x'` marks a message as a REQUEST whose RESPONSE has type 'x'
//   - bump `version` whenever you change anything in a way that breaks old clients (0..15);
//     a packet with a different version throws ProtocolVersionError

export const schema = {
  version: 1,

  // Packets bigger than this are split into chunks automatically. Cloudflare currently
  // accepts received WebSocket messages up to 32 MiB; 1 MiB keeps memory use modest and
  // is safe under any limit. Raise it if you want fewer chunks.
  maxPacket: 1_048_576,

  requestTimeout: 10_000, // ms, default for request()

  messages: {
    // server requests audio data from client, client responds
    audioRequest: { fields: { }, reply: 'audioPacket' },
    audioPacket: { fields: { ts: 'ts' }, payload: true },

    // server sends score to client
    colocation: { fields: { score: 'f32', peer: 'uid' } },

    // trigger event
    trigger: { fields: {} },

    // timestamp update from server to client
    tsUpdate: { fields: { ts: 'ts' } },

    // // client -> server: "I'm starting something"
    // begin:    { fields: { ts: 'ts', kind: 'u8' } },

    // // server -> client(s): something changed (uid says who did it)
    // update:   { fields: { uid: 'uid', ts: 'ts', slot: 'u8' }, payload: true },

    // // server -> client: "send me slot N" ... client answers with `data`
    // getData:  { fields: { slot: 'u8' }, reply: 'data' },
    // data:     { fields: { slot: 'u8' }, payload: true },

    // // anything, either direction
    // notice:   { fields: { text: 'str' } },
  },
};