/**
 * Minimal RTP framing helpers — parse incoming packets, build outgoing ones.
 *
 * Only what we need for Asterisk External Media over UDP: fixed 12-byte header,
 * optional extension header, optional CSRC list, optional trailing padding.
 * No SRTP, no RTCP, no encryption.
 *
 * RFC 3550, §5.1 (fixed header):
 *
 *   0                   1                   2                   3
 *   0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |V=2|P|X|  CC   |M|     PT      |       sequence number         |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |                           timestamp                           |
 *  +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
 *  |           synchronization source (SSRC) identifier            |
 *  +=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+=+
 */

const RTP_VERSION = 2;

/**
 * Parse one RTP packet buffer.
 * @param {Buffer} buf
 * @returns {{
 *   version: number, marker: number, payloadType: number,
 *   sequenceNumber: number, timestamp: number, ssrc: number,
 *   payload: Buffer
 * }}
 */
export function parseRtpPacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) {
    throw new Error(`RTP packet too short: ${buf?.length ?? 'not a buffer'}`);
  }

  const b0 = buf[0];
  const version = (b0 >> 6) & 0x03;
  const padding = (b0 >> 5) & 0x01;
  const extension = (b0 >> 4) & 0x01;
  const csrcCount = b0 & 0x0f;

  if (version !== RTP_VERSION) {
    throw new Error(`unsupported RTP version: ${version}`);
  }

  const b1 = buf[1];
  const marker = (b1 >> 7) & 0x01;
  const payloadType = b1 & 0x7f;

  const sequenceNumber = buf.readUInt16BE(2);
  const timestamp = buf.readUInt32BE(4);
  const ssrc = buf.readUInt32BE(8);

  // Skip past fixed header + CSRC list.
  let headerLength = 12 + 4 * csrcCount;

  // Optional extension header: 4 bytes of (id + length_in_words) + payload.
  if (extension) {
    if (buf.length < headerLength + 4) {
      throw new Error('RTP extension header truncated');
    }
    const extLenWords = buf.readUInt16BE(headerLength + 2);
    headerLength += 4 + 4 * extLenWords;
    if (buf.length < headerLength) {
      throw new Error('RTP extension payload truncated');
    }
  }

  // Optional padding: last byte of the packet is the pad count (includes itself).
  let payloadEnd = buf.length;
  if (padding) {
    const padLen = buf[buf.length - 1];
    if (padLen < 1 || headerLength + padLen > buf.length) {
      throw new Error(`RTP padding length invalid: ${padLen}`);
    }
    payloadEnd -= padLen;
  }

  return {
    version,
    marker,
    payloadType,
    sequenceNumber,
    timestamp,
    ssrc,
    payload: buf.subarray(headerLength, payloadEnd),
  };
}

/**
 * Build one RTP packet. Fixed header only — no CSRC, no extensions, no padding.
 * @param {{
 *   payloadType: number,
 *   sequenceNumber: number,
 *   timestamp: number,
 *   ssrc: number,
 *   payload: Buffer,
 *   marker?: number
 * }} opts
 * @returns {Buffer}
 */
export function buildRtpPacket({
  payloadType,
  sequenceNumber,
  timestamp,
  ssrc,
  payload,
  marker = 0,
}) {
  if (!Buffer.isBuffer(payload)) {
    throw new Error('buildRtpPacket: payload must be a Buffer');
  }
  const header = Buffer.alloc(12);
  // V=2, P=0, X=0, CC=0  →  10 000 000 = 0x80
  header[0] = 0x80;
  header[1] = ((marker & 0x01) << 7) | (payloadType & 0x7f);
  header.writeUInt16BE(sequenceNumber & 0xffff, 2);
  header.writeUInt32BE(timestamp >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return Buffer.concat([header, payload]);
}

/** Random 32-bit SSRC. */
export function randomSsrc() {
  return (Math.random() * 0x1_0000_0000) >>> 0;
}
