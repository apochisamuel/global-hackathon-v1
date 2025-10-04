const video = document.getElementById('video');
const emotionText = document.getElementById('emotion-text');
const player = document.getElementById('music-player');
const modeSelect = document.getElementById('mode');
const manualMood = document.getElementById('manualMood');

// 🎥 Request camera access and wait until ready
navigator.mediaDevices.getUserMedia({ video: true })
  .then(stream => {
    video.srcObject = stream;
    video.addEventListener('loadeddata', () => {
      console.log("✅ Camera ready, starting mood detection...");
      detectMood();
    });
  })
  .catch(err => console.error("❌ Camera error:", err));

function detectMood() {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  setInterval(async () => {
    // Ensure valid video dimensions
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      console.warn("⏳ Waiting for camera to initialize...");
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/jpeg');
    const mode = modeSelect.value;
    const overrideMood = manualMood.value.trim();

    console.log("📸 Captured frame length:", dataUrl.length);

    try {
      let payload = { image: dataUrl, mode: mode };

      // --- Manual mood override ---
      if (overrideMood) {
        console.log("🎚️ Manual mood selected:", overrideMood);
        emotionText.textContent = `You selected ${overrideMood} 🎵`;

        const resp = await fetch(`/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const result = await resp.json();
        console.log("🎧 Server response (manual):", result);

        if (result.playlist) player.src = result.playlist;
        return; // Skip automatic detection this cycle
      }

      // --- Automatic detection ---
      const response = await fetch('/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const result = await response.json();
      console.log("🧠 Server response:", result);

      if (result.error) {
        console.error("Server error:", result.error);
        return;
      }

      if (result.emotion && result.playlist) {
        emotionText.textContent = `You seem ${result.emotion} 🎵`;
        player.src = result.playlist;
      }

    } catch (err) {
      console.error("⚠️ Mood detection error:", err);
    }
  }, 8000); // every 8 seconds
}
