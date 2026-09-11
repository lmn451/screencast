// Unit tests for media-recorder-utils.js

import { jest } from '@jest/globals';
import {
  getOptimalCodec,
  getDisplayVideoConstraints,
  applyContentHints,
  combineStreams,
  waitForCombinedStreamReady,
  cleanupCombinedStream,
  setupAutoStop,
  CHUNK_INTERVAL_MS,
  BEST_QUALITY_FRAME_RATE,
  MIXED_AUDIO_RESUME_TIMEOUT_MS,
} from '../../src/lib/media-recorder-utils.js';

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
      expect(global.MediaRecorder.isTypeSupported).toHaveBeenCalledWith(
        'video/webm;codecs=av01,opus'
      );
      expect(global.MediaRecorder.isTypeSupported).toHaveBeenCalledWith(
        'video/webm;codecs=av1,opus'
      );
      expect(global.MediaRecorder.isTypeSupported).toHaveBeenCalledWith(
        'video/webm;codecs=vp9,opus'
      );
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

  describe('getDisplayVideoConstraints', () => {
    it('keeps browser defaults for standard quality', () => {
      expect(getDisplayVideoConstraints(false)).toBe(true);
    });

    it('targets up to 60 FPS for best quality', () => {
      expect(getDisplayVideoConstraints(true)).toEqual({
        frameRate: { ideal: BEST_QUALITY_FRAME_RATE, max: BEST_QUALITY_FRAME_RATE },
      });
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
    it('should mix display and mic audio into one recorded track', async () => {
      const videoTrack = { kind: 'video', stop: jest.fn() };
      const displayAudioTrack = { kind: 'audio', label: 'system', stop: jest.fn() };
      const micAudioTrack = { kind: 'audio', label: 'mic', stop: jest.fn() };
      const mixedAudioTrack = { kind: 'audio', label: 'mixed', stop: jest.fn() };
      const sourceNodes = [];
      const gainNodes = [];
      const audioContext = {
        state: 'suspended',
        createMediaStreamDestination: jest.fn(() => ({
          stream: { getAudioTracks: () => [mixedAudioTrack] },
        })),
        createMediaStreamSource: jest.fn((stream) => {
          const source = {
            stream,
            connect: jest.fn(),
            disconnect: jest.fn(),
          };
          sourceNodes.push(source);
          return source;
        }),
        createGain: jest.fn(() => {
          const gain = {
            gain: { value: 1 },
            connect: jest.fn(),
            disconnect: jest.fn(),
          };
          gainNodes.push(gain);
          return gain;
        }),
        resume: jest.fn(async () => {
          audioContext.state = 'running';
        }),
        close: jest.fn(async () => {
          audioContext.state = 'closed';
        }),
      };

      const displayStream = {
        getVideoTracks: () => [videoTrack],
        getAudioTracks: () => [displayAudioTrack],
      };

      const micStream = {
        getAudioTracks: () => [micAudioTrack],
      };

      global.AudioContext = jest.fn(() => audioContext);
      global.MediaStream = jest.fn(function (tracks) {
        this.tracks = tracks;
        this.getTracks = () => this.tracks;
      });

      const combined = combineStreams({ displayStream, micStream });
      expect(combined.tracks).toHaveLength(2);
      expect(combined.tracks).toContain(videoTrack);
      expect(combined.tracks).toContain(mixedAudioTrack);
      expect(combined.tracks).not.toContain(displayAudioTrack);
      expect(combined.tracks).not.toContain(micAudioTrack);
      expect(audioContext.createMediaStreamSource).toHaveBeenNthCalledWith(1, displayStream);
      expect(audioContext.createMediaStreamSource).toHaveBeenNthCalledWith(2, micStream);
      expect(sourceNodes[0].connect).toHaveBeenCalledWith(gainNodes[0]);
      expect(sourceNodes[1].connect).toHaveBeenCalledWith(gainNodes[1]);
      expect(gainNodes[0].connect).toHaveBeenCalled();
      expect(gainNodes[1].connect).toHaveBeenCalled();

      await expect(waitForCombinedStreamReady(combined)).resolves.toBeUndefined();
      expect(audioContext.resume).toHaveBeenCalledTimes(1);

      await cleanupCombinedStream(combined);
      expect(displayAudioTrack.stop).toHaveBeenCalledTimes(1);
      expect(micAudioTrack.stop).toHaveBeenCalledTimes(1);
      expect(mixedAudioTrack.stop).toHaveBeenCalledTimes(1);
      expect(videoTrack.stop).toHaveBeenCalledTimes(1);
      expect(sourceNodes[0].disconnect).toHaveBeenCalledTimes(1);
      expect(sourceNodes[1].disconnect).toHaveBeenCalledTimes(1);
      expect(gainNodes[0].disconnect).toHaveBeenCalledTimes(1);
      expect(gainNodes[1].disconnect).toHaveBeenCalledTimes(1);
      expect(audioContext.close).toHaveBeenCalledTimes(1);

      // The cleanup hook is safe to invoke again from a stop/unload race.
      await cleanupCombinedStream(combined);
      expect(audioContext.close).toHaveBeenCalledTimes(1);
    });

    it('should preserve tracks when there is only one audio source', () => {
      const videoTrack = { kind: 'video', stop: jest.fn() };
      const displayAudioTrack = { kind: 'audio', label: 'system', stop: jest.fn() };
      const displayStream = {
        getVideoTracks: () => [videoTrack],
        getAudioTracks: () => [displayAudioTrack],
      };

      global.MediaStream = jest.fn(function (tracks) {
        this.tracks = tracks;
      });

      const combined = combineStreams({ displayStream, micStream: null });
      expect(combined.tracks).toHaveLength(2);
      expect(combined.tracks).toContain(videoTrack);
      expect(combined.tracks).toContain(displayAudioTrack);
      expect(global.AudioContext).toBeDefined();
      expect(global.AudioContext).not.toHaveBeenCalled();
    });

    it('fails dual-source startup when a suspended context cannot resume', async () => {
      const displayAudioTrack = { kind: 'audio', stop: jest.fn() };
      const micAudioTrack = { kind: 'audio', stop: jest.fn() };
      const mixedAudioTrack = { kind: 'audio', stop: jest.fn() };
      const audioContext = {
        state: 'suspended',
        createMediaStreamDestination: () => ({
          stream: { getAudioTracks: () => [mixedAudioTrack] },
        }),
        createMediaStreamSource: () => ({
          connect: jest.fn(),
          disconnect: jest.fn(),
        }),
        resume: jest.fn(() => Promise.reject(new Error('autoplay blocked'))),
        close: jest.fn(async () => {
          audioContext.state = 'closed';
        }),
      };
      const displayStream = {
        getVideoTracks: () => [],
        getAudioTracks: () => [displayAudioTrack],
      };
      const micStream = { getAudioTracks: () => [micAudioTrack] };

      global.AudioContext = jest.fn(() => audioContext);
      global.MediaStream = jest.fn(function (tracks) {
        this.tracks = tracks;
        this.getTracks = () => this.tracks;
      });

      const combined = combineStreams({ displayStream, micStream });
      await expect(waitForCombinedStreamReady(combined)).rejects.toThrow('autoplay blocked');
      expect(displayAudioTrack.stop).toHaveBeenCalledTimes(1);
      expect(micAudioTrack.stop).toHaveBeenCalledTimes(1);
      expect(audioContext.close).toHaveBeenCalledTimes(1);
    });

    it('times out a context that stays suspended and releases every owned resource', async () => {
      jest.useFakeTimers();
      try {
        const videoTrack = { kind: 'video', stop: jest.fn() };
        const displayAudioTrack = { kind: 'audio', stop: jest.fn() };
        const micAudioTrack = { kind: 'audio', stop: jest.fn() };
        const mixedAudioTrack = { kind: 'audio', stop: jest.fn() };
        const sourceNodes = [];
        const audioContext = {
          state: 'suspended',
          createMediaStreamDestination: () => ({
            stream: { getAudioTracks: () => [mixedAudioTrack] },
          }),
          createMediaStreamSource: () => {
            const source = {
              connect: jest.fn(),
              disconnect: jest.fn(),
            };
            sourceNodes.push(source);
            return source;
          },
          createGain: jest.fn(() => ({
            gain: { value: 1 },
            connect: jest.fn(),
            disconnect: jest.fn(),
          })),
          // Deliberately never settle: this models an autoplay/sticky
          // activation request that the browser leaves pending.
          resume: jest.fn(() => new Promise(() => {})),
          close: jest.fn(async () => {
            audioContext.state = 'closed';
          }),
        };
        const displayStream = {
          getVideoTracks: () => [videoTrack],
          getAudioTracks: () => [displayAudioTrack],
        };
        const micStream = { getAudioTracks: () => [micAudioTrack] };

        global.AudioContext = jest.fn(() => audioContext);
        global.MediaStream = jest.fn(function (tracks) {
          this.tracks = tracks;
          this.getTracks = () => this.tracks;
        });

        const combined = combineStreams({ displayStream, micStream });
        const ready = waitForCombinedStreamReady(combined);
        const readyRejection = expect(ready).rejects.toMatchObject({
          name: 'TimeoutError',
          message: expect.stringContaining(`${MIXED_AUDIO_RESUME_TIMEOUT_MS}ms`),
        });
        await jest.advanceTimersByTimeAsync(MIXED_AUDIO_RESUME_TIMEOUT_MS);

        await readyRejection;
        expect(audioContext.resume).toHaveBeenCalledTimes(1);
        expect(audioContext.close).toHaveBeenCalledTimes(1);
        expect(displayAudioTrack.stop).toHaveBeenCalledTimes(1);
        expect(micAudioTrack.stop).toHaveBeenCalledTimes(1);
        expect(videoTrack.stop).toHaveBeenCalledTimes(1);
        expect(mixedAudioTrack.stop).toHaveBeenCalledTimes(1);
        expect(sourceNodes[0].disconnect).toHaveBeenCalledTimes(1);
        expect(sourceNodes[1].disconnect).toHaveBeenCalledTimes(1);

        await cleanupCombinedStream(combined);
        expect(audioContext.close).toHaveBeenCalledTimes(1);
      } finally {
        jest.useRealTimers();
      }
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
