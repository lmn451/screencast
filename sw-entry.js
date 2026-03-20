/**
 * Clean Entry Point для Service Worker
 * 
 * ВАЖНО: Этот файл НЕ экспортирует ничего!
 * esbuild увидит отсутствие exports и сгенерирует чистый IIFE,
 * не переопределяя глобальный `self` Service Worker-а.
 */
import { initBackground } from './background.js';

// Просто вызываем инициализацию - никаких экспортов!
initBackground();
