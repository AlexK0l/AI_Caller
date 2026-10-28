import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeVoxMessage, encodeVoxAudio } from '../src/telephony/media.js';

test('Voximplant JSON media is decoded to precisely the original ArrayBuffer bytes', () => {
  const payload = Buffer.from([255, 0, 128, 4, 42]);
  const frame = JSON.stringify({ event: 'media', media: { tag: 'caller', payload: payload.toString('base64') } });
  const actual = decodeVoxMessage(Buffer.from(frame));
  assert.equal(actual.kind, 'audio');
  assert.deepEqual(Buffer.from(actual.audio), payload);
});
test('OpenAI audio is encoded as Voximplant JSON media', () => {
  const bytes = Uint8Array.from([1, 2, 255]);
  const event = JSON.parse(encodeVoxAudio(bytes.buffer));
  assert.equal(event.event, 'media');
  assert.equal(event.media.tag, 'assistant');
  assert.deepEqual(Buffer.from(event.media.payload, 'base64'), Buffer.from(bytes));
});
test('control events remain separate from audio', () => {
  const result = decodeVoxMessage(JSON.stringify({ type: 'connected', callId: 'abc' }));
  assert.deepEqual(result, { kind: 'event', event: { type: 'connected', callId: 'abc' } });
});
test('malformed or binary frames are rejected', () => {
  assert.throws(() => decodeVoxMessage(Buffer.from([1]), true), /binary/);
  assert.throws(() => decodeVoxMessage('{'), /invalid_voximplant_json/);
  assert.throws(() => decodeVoxMessage(JSON.stringify({ event: 'media', media: { payload: '$$$' } })), /invalid_voximplant_audio/);
});
