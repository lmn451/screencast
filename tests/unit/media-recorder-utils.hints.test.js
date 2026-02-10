import { jest } from '@jest/globals';

import { applyContentHints } from '../../media-recorder-utils.js';

describe('applyContentHints additional cases', () => {
  beforeEach(() => jest.clearAllMocks());

  it('applies detail to video and speech overrides music when both flags set', () => {
    const videoTrack = { contentHint: '' };
    const systemTrack = { contentHint: '' };
    const micTrack = { contentHint: '' };

    const stream = {
      getVideoTracks: jest.fn(() => [videoTrack]),
      getAudioTracks: jest.fn(() => [systemTrack, micTrack]),
    };

    applyContentHints(stream, { hasSystemAudio: true, hasMicrophone: true });

    expect(videoTrack.contentHint).toBe('detail');
    // Microphone processing runs after system audio and should set 'speech'
    expect(systemTrack.contentHint).toBe('speech');
    expect(micTrack.contentHint).toBe('speech');
  });

  it('only sets contentHint on tracks that support the property', () => {
    const videoTrack = { contentHint: '' };
    const audioWith = { contentHint: '' };
    const audioWithout = {}; // no contentHint

    const stream = {
      getVideoTracks: jest.fn(() => [videoTrack]),
      getAudioTracks: jest.fn(() => [audioWith, audioWithout]),
    };

    expect(() => applyContentHints(stream, { hasSystemAudio: true })).not.toThrow();
    expect(videoTrack.contentHint).toBe('detail');
    expect(audioWith.contentHint).toBe('music');
    expect('contentHint' in audioWithout).toBe(false);
  });
});
