// Unit tests for media-recorder-utils.js

import { jest } from '@jest/globals';
import {
  getOptimalCodec,
  applyContentHints,
  combineStreams,
  setupAutoStop,
  CHUNK_INTERVAL_MS,
} from '../../media-recorder-utils.js';

describe('media-recorder-utils.js', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getOptimalCodec', () => {
    it('should return first supported codec', () => {
      global.MediaRecorder = {
        isTypeSupported: jest.fn((type) => {
          return type === 'video/webm;codecs=vp9,opus';
        }),
      };

      const codec = getOptimalCodec();
      expect(codec).toBe('video/webm;codecs=vp9,opus');
    });

    it('should try codecs in priority order', () => {
      const supportedTypes = new Set(['video/webm;codecs=vp8,opus']);
      global.MediaRecorder = {
        isTypeSupported: jest.fn((type) => supportedTypes.has(type)),
      };

      const codec = getOptimalCodec();
      expect(codec).toBe('video/webm;codecs=vp8,opus');
      
      // Should have tried higher priority codecs first
      expect(global.MediaRecorder.isTypeSupported).toHaveBeenCalledWith('video/webm;codecs=av01,opus');
      expect(global.MediaRecorder.isTypeSupported).toHaveBeenCalledWith('video/webm;codecs=av1,opus');
      expect(global.MediaRecorder.isTypeSupported).toHaveBeenCalledWith('video/webm;codecs=vp9,opus');
    });

    it('should fallback to generic webm', () => {
      global.MediaRecorder = {
        isTypeSupported: jest.fn((type) => type === 'video/webm'),
      };

      const codec = getOptimalCodec();
      expect(codec).toBe('video/webm');
    });

    it('should throw error if no codecs supported', () => {
      global.MediaRecorder = {
        isTypeSupported: jest.fn(() => false),
      };

      expect(() => getOptimalCodec()).toThrow('No supported video codec found');
    });
  });

  describe('applyContentHints', () => {
    it('should apply detail hint to video track', () => {
      const videoTrack = { contentHint: '' };
      const stream = {
        getVideoTracks: jest.fn(() => [videoTrack]),
        getAudioTracks: jest.fn(() => []),
      };

      applyContentHints(stream);
      expect(videoTrack.contentHint).toBe('detail');
    });

    it('should apply music hint to system audio', () => {
      const audioTrack = { contentHint: '' };
      const stream = {
        getVideoTracks: jest.fn(() => []),
        getAudioTracks: jest.fn(() => [audioTrack]),
      };

      applyContentHints(stream, { hasSystemAudio: true });
      expect(audioTrack.contentHint).toBe('music');
    });

    it('should apply speech hint to microphone', () => {
      const micTrack = { contentHint: '' };
      const stream = {
        getVideoTracks: jest.fn(() => []),
        getAudioTracks: jest.fn(() => [micTrack]),
      };

      applyContentHints(stream, { hasMicrophone: true });
      expect(micTrack.contentHint).toBe('speech');
    });

    it('should handle streams without contentHint support', () => {
      const videoTrack = {}; // No contentHint property
      const stream = {
        getVideoTracks: jest.fn(() => [videoTrack]),
        getAudioTracks: jest.fn(() => []),
      };

      expect(() => applyContentHints(stream)).not.toThrow();
    });

    it('should handle missing getVideoTracks method', () => {
      const stream = {};
      expect(() => applyContentHints(stream)).not.toThrow();
    });

    it('should handle errors gracefully', () => {
      const stream = {
        getVideoTracks: jest.fn(() => {
          throw new Error('Track error');
        }),
        getAudioTracks: jest.fn(() => []),
      };

      expect(() => applyContentHints(stream)).not.toThrow();
    });
  });

  describe('combineStreams', () => {
    it('should combine display and mic streams', () => {
      const videoTrack = { kind: 'video' };
      const displayAudioTrack = { kind: 'audio', label: 'system' };
      const micAudioTrack = { kind: 'audio', label: 'mic' };

      const displayStream = {
        getVideoTracks: () => [videoTrack],
        getAudioTracks: () => [displayAudioTrack],
      };

      const micStream = {
        getAudioTracks: () => [micAudioTrack],
      };

      global.MediaStream = jest.fn(function (tracks) {
        this.tracks = tracks;
      });

      const combined = combineStreams({ displayStream, micStream });
      expect(combined.tracks).toHaveLength(3);
      expect(combined.tracks).toContain(videoTrack);
      expect(combined.tracks).toContain(displayAudioTrack);
      expect(combined.tracks).toContain(micAudioTrack);
    });

    it('should work without mic stream', () => {
      const videoTrack = { kind: 'video' };
      const displayStream = {
        getVideoTracks: () => [videoTrack],
        getAudioTracks: () => [],
      };

      global.MediaStream = jest.fn(function (tracks) {
        this.tracks = tracks;
      });

      const combined = combineStreams({ displayStream, micStream: null });
      expect(combined.tracks).toHaveLength(1);
      expect(combined.tracks).toContain(videoTrack);
    });
  });

  describe('setupAutoStop', () => {
    it('should add ended listener to video tracks', () => {
      const videoTrack = {
        addEventListener: jest.fn(),
      };
      const stream = {
        getVideoTracks: () => [videoTrack],
      };
      const recorder = {
        state: 'recording',
        requestData: jest.fn(),
        stop: jest.fn(),
      };

      setupAutoStop(stream, recorder);
      expect(videoTrack.addEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
    });

    it('should stop recorder when track ends', () => {
      let endedCallback;
      const videoTrack = {
        addEventListener: jest.fn((event, callback) => {
          if (event === 'ended') endedCallback = callback;
        }),
      };
      const stream = {
        getVideoTracks: () => [videoTrack],
      };
      const recorder = {
        state: 'recording',
        requestData: jest.fn(),
        stop: jest.fn(),
      };

      setupAutoStop(stream, recorder);
      
      // Trigger ended event
      endedCallback();
      
      expect(recorder.requestData).toHaveBeenCalled();
      expect(recorder.stop).toHaveBeenCalled();
    });

    it('should not stop if recorder already inactive', () => {
      let endedCallback;
      const videoTrack = {
        addEventListener: jest.fn((event, callback) => {
          if (event === 'ended') endedCallback = callback;
        }),
      };
      const stream = {
        getVideoTracks: () => [videoTrack],
      };
      const recorder = {
        state: 'inactive',
        requestData: jest.fn(),
        stop: jest.fn(),
      };

      setupAutoStop(stream, recorder);
      endedCallback();
      
      expect(recorder.stop).not.toHaveBeenCalled();
    });

    it('should handle multiple video tracks', () => {
      const videoTrack1 = { addEventListener: jest.fn() };
      const videoTrack2 = { addEventListener: jest.fn() };
      const stream = {
        getVideoTracks: () => [videoTrack1, videoTrack2],
      };
      const recorder = { state: 'recording' };

      setupAutoStop(stream, recorder);
      
      expect(videoTrack1.addEventListener).toHaveBeenCalled();
      expect(videoTrack2.addEventListener).toHaveBeenCalled();
    });
  });

  describe('CHUNK_INTERVAL_MS', () => {
    it('should be defined as 1000ms', () => {
      expect(CHUNK_INTERVAL_MS).toBe(1000);
    });
  });
});
