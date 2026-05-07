// Unit tests for feedback.js

// Jest testEnvironment is jsdom, so global document is available
// No JSDOM import needed - Jest provides document automatically
import { showToast, showBanner, updateStatusText } from '../../src/feedback.js';

describe('feedback.js', () => {
  let container;

  beforeEach(() => {
    // Jest testEnvironment is jsdom, so global document is already available
    container = document.getElementById('test-container') || document.body;
    // Clean any leftover elements
    document.querySelectorAll('.toast, .diags-banner').forEach((el) => el.remove());
  });

  afterEach(() => {
    // Clean up any created elements
    document.querySelectorAll('.toast, .diags-banner').forEach((el) => el.remove());
  });

  describe('showToast', () => {
    it('should create toast element and add to container', () => {
      showToast(container, 'Test message', 'info');
      const toast = container.querySelector('.toast');
      expect(toast).not.toBeNull();
      expect(toast.textContent).toBe('Test message');
    });

    it('should set correct role attribute for accessibility', () => {
      showToast(container, 'Test message', 'info');
      const toast = container.querySelector('.toast');
      expect(toast.getAttribute('role')).toBe('alert');
    });

    it('should apply success styles for type success', () => {
      showToast(container, 'Success!', 'success');
      const toast = container.querySelector('.toast');
      expect(toast.classList.contains('toast-success')).toBe(true);
    });

    it('should apply error styles for type error', () => {
      showToast(container, 'Error!', 'error');
      const toast = container.querySelector('.toast');
      expect(toast.classList.contains('toast-error')).toBe(true);
    });

    it('should apply warning styles for type warning', () => {
      showToast(container, 'Warning!', 'warning');
      const toast = container.querySelector('.toast');
      expect(toast.classList.contains('toast-warning')).toBe(true);
    });

    it('should auto-remove toast after duration', async () => {
      const shortDuration = 100;
      showToast(container, 'Test message', 'info', shortDuration);

      const toast = container.querySelector('.toast');
      expect(toast).not.toBeNull();

      // Wait for auto-dismiss (duration + fade transition + buffer)
      await new Promise((resolve) => setTimeout(resolve, shortDuration + 300));

      // Toast should be removed
      const removedToast = container.querySelector('.toast');
      expect(removedToast).toBeNull();
    });

    it('should handle null container gracefully', () => {
      expect(() => showToast(null, 'Test')).not.toThrow();
    });

    it('should use default type info when not specified', () => {
      showToast(container, 'Test message');
      const toast = container.querySelector('.toast');
      expect(toast.classList.contains('toast-info')).toBe(true);
    });

    it('should use default duration of 3000ms', async () => {
      const before = Date.now();
      showToast(container, 'Test message');

      // Wait a bit then check
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(container.querySelector('.toast')).not.toBeNull();

      // After default duration + fade transition + buffer
      await new Promise((resolve) => setTimeout(resolve, 3500));
      expect(container.querySelector('.toast')).toBeNull();
    });
  });

  describe('showBanner', () => {
    it('should create banner element', () => {
      const banner = showBanner('Test banner message');
      const el = document.querySelector('.diags-banner');
      expect(el).not.toBeNull();
      expect(el.textContent).toBe('Test banner message');
    });

    it('should set role alert for accessibility', () => {
      showBanner('Test message');
      const banner = document.querySelector('.diags-banner');
      expect(banner.getAttribute('role')).toBe('alert');
    });

    it('should remove existing banner before creating new one', () => {
      showBanner('First banner');
      showBanner('Second banner');
      const banners = document.querySelectorAll('.diags-banner');
      expect(banners).toHaveLength(1);
      expect(banners[0].textContent).toBe('Second banner');
    });

    it('should auto-dismiss after 4000ms', async () => {
      showBanner('Test banner');

      await new Promise((resolve) => setTimeout(resolve, 4500));

      const banner = document.querySelector('.diags-banner');
      expect(banner).toBeNull();
    });

    it('should return banner element', () => {
      const banner = showBanner('Test banner');
      expect(banner).toBeInstanceOf(global.HTMLElement);
      expect(banner.classList.contains('diags-banner')).toBe(true);
    });
  });

  describe('updateStatusText', () => {
    it('should update text content', () => {
      const el = document.createElement('div');
      el.textContent = 'Initial';
      document.body.appendChild(el);

      updateStatusText(el, 'Updated text');

      expect(el.textContent).toBe('Updated text');
      el.remove();
    });

    it('should set color for success type', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);

      updateStatusText(el, 'Success', 'success');

      // jsdom returns rgb format
      expect(el.style.color).toMatch(/^rgb\(30, 126, 52\)$/);
      el.remove();
    });

    it('should set color for error type', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);

      updateStatusText(el, 'Error', 'error');

      // jsdom returns rgb format
      expect(el.style.color).toMatch(/^rgb\(197, 34, 31\)$/);
      el.remove();
    });

    it('should set color for warning type', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);

      updateStatusText(el, 'Warning', 'warning');

      // jsdom returns rgb format
      expect(el.style.color).toMatch(/^rgb\(176, 96, 0\)$/);
      el.remove();
    });

    it('should set color for info type', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);

      updateStatusText(el, 'Info', 'info');

      // jsdom returns rgb format
      expect(el.style.color).toMatch(/^rgb\(51, 51, 51\)$/);
      el.remove();
    });

    it('should not set color if type is undefined', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);

      updateStatusText(el, 'No type specified');

      // When type is undefined, color should not be set (empty in jsdom)
      expect(el.style.color).toBe('');
      el.remove();
    });

    it('should handle null element gracefully', () => {
      expect(() => updateStatusText(null, 'Test')).not.toThrow();
    });

    it('should handle undefined type gracefully', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);

      expect(() => updateStatusText(el, 'Test', undefined)).not.toThrow();
      expect(el.textContent).toBe('Test');
      el.remove();
    });
  });
});
