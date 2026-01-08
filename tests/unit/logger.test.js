// Unit tests for logger.js

import { jest } from '@jest/globals';
import { createLogger, log, warn, error } from '../../logger.js';

describe('logger.js', () => {
  describe('createLogger', () => {
    it('should create a logger with component prefix', () => {
      const logger = createLogger('TestComponent');
      expect(logger).toHaveProperty('log');
      expect(logger).toHaveProperty('warn');
      expect(logger).toHaveProperty('error');
    });

    it('should return logger with correct structure', () => {
      const logger = createLogger('TestComponent');
      expect(typeof logger.log).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
    });

    it('should create different loggers for different components', () => {
      const logger1 = createLogger('Component1');
      const logger2 = createLogger('Component2');
      
      // They should be different objects
      expect(logger1).not.toBe(logger2);
    });

    it('should not throw when calling logger methods', () => {
      const logger = createLogger('TestComponent');
      
      // These should not throw even though console is mocked
      expect(() => logger.log('test')).not.toThrow();
      expect(() => logger.warn('test')).not.toThrow();
      expect(() => logger.error('test')).not.toThrow();
    });

    it('should handle multiple arguments without throwing', () => {
      const logger = createLogger('Multi');
      
      expect(() => {
        logger.warn('message', { foo: 'bar' }, [1, 2, 3], 123);
      }).not.toThrow();
      
      expect(() => {
        logger.error('error', new Error('test'), { data: 'value' });
      }).not.toThrow();
    });
  });

  describe('exported functions', () => {
    it('should export log function', () => {
      expect(typeof log).toBe('function');
    });

    it('should export warn function', () => {
      expect(typeof warn).toBe('function');
    });

    it('should export error function', () => {
      expect(typeof error).toBe('function');
    });
  });
});
