document.getElementById('recordTab').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'startRecording', source: 'tab' });
  window.close();
});

document.getElementById('recordScreen').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'startRecording', source: 'screen' });
  window.close();
});

document.getElementById('recordWindow').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'startRecording', source: 'window' });
  window.close();
});