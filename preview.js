const urlParams = new URLSearchParams(window.location.search);
const videoUrl = urlParams.get('video');

if (videoUrl) {
  const videoPlayer = document.getElementById('videoPlayer');
  videoPlayer.src = decodeURIComponent(videoUrl);
}

document.getElementById('downloadBtn').addEventListener('click', () => {
  if (videoUrl) {
    const a = document.createElement('a');
    a.href = decodeURIComponent(videoUrl);
    a.download = 'recording.webm';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
});