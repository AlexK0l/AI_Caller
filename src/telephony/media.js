// Voximplant Media Streams: JSON text frames containing base64 G.711 mu-law.
// Never forward the JSON envelope or base64 bytes directly to OpenAI.
const MAX_AUDIO_BYTES = 512 * 1024;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function decodeVoxMessage(data, isBinary = false) {
  if (isBinary) throw new Error('unexpected_binary_media_frame');
  let message;
  try {
    message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
  } catch {
    throw new Error('invalid_voximplant_json');
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('invalid_voximplant_event');
  }
  if (message.event !== 'media') return { kind: 'event', event: message };
  const payload = message.media?.payload;
  if (typeof payload !== 'string' || !payload || payload.length > MAX_AUDIO_BYTES * 2 || !BASE64.test(payload)) {
    throw new Error('invalid_voximplant_audio');
  }
  const bytes = Buffer.from(payload, 'base64');
  if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) throw new Error('invalid_voximplant_audio_size');
  const audio = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return { kind: 'audio', audio };
}

export function encodeVoxAudio(audio, tag = 'assistant') {
  const buffer = audio instanceof ArrayBuffer
    ? Buffer.from(audio)
    : ArrayBuffer.isView(audio)
      ? Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength)
      : Buffer.from(audio);
  if (!buffer.length || buffer.length > MAX_AUDIO_BYTES) throw new Error('invalid_output_audio_size');
  return JSON.stringify({ event: 'media', media: { tag, payload: buffer.toString('base64') } });
}
