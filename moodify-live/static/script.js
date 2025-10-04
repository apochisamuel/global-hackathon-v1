// static/script.js — updated: smoothing + safer Start Session
// Local-only demo frontend (works with /analyze endpoint from your local app.py)

const video = document.getElementById('video');
const emotionText = document.getElementById('emotion-text');
const startBtn = document.getElementById('startBtn');
const audioHint = document.getElementById('audio-hint');
const playbackStatus = document.getElementById('playback-status');
const nowSongLabel = document.getElementById('now-song');
const nextSongLabel = document.getElementById('next-song');
const queueList = document.getElementById('queue-list');
const modeSelect = document.getElementById('mode');
const manualMood = document.getElementById('manualMood');

const audioA = document.getElementById('audioA');
const audioB = document.getElementById('audioB');

let activeAudio = audioA;
let idleAudio = audioB;

let userInteracted = false;
let trackQueue = []; // queued tracks
let currentTrack = null;
let fetchingNext = false;

// Smoothing / stability params
const EMOTION_HISTORY_LEN = 5;   // how many recent detection results to keep
const EMOTION_REQUIRED = 3;      // how many agree to consider "stable" (>=)
let recentEmotions = [];         // array of strings
let lastCommittedMood = null;
let lastCommitTime = 0;
const MIN_RECOMMIT_MS = 6000;    // avoid re-committing mood too often

// Timing & crossfade
const CHECK_INTERVAL_MS = 600;
const CROSSFADE_SECONDS = 2.0;

// === Start Session button ===
// FIX: Do not pause if audio already playing. Only use this to unlock audio if it was blocked.
startBtn.addEventListener('click', async () => {
  userInteracted = true;
  audioHint.style.display = 'none';
  playbackStatus.classList.add('hidden');

  // If audio is playing, don't interrupt it.
  if (!activeAudio.paused && activeAudio.currentTime > 0 && !activeAudio.ended) {
    // Audio already playing: just mark session started.
    startBtn.disabled = true;
    startBtn.textContent = "Session started ✅";
    console.log("Start: audio already playing — not interrupting.");
    return;
  }

  // If audio is paused or hasn't started due to autoplay block, try to play
  try {
    await activeAudio.play();
    activeAudio.pause(); // quick play/pause just to unlock in some browsers (safe because audio wasn't playing)
  } catch (e) {
    // Some browsers may throw; it's okay — userInteracted is set and we'll retry when needed
    console.warn("Start gesture quick play failed (expected in some browsers):", e);
  }

  startBtn.disabled = true;
  startBtn.textContent = "Session started ✅";
  console.log("Start: user gesture registered, audio unlocked if blocked.");
});

// === Camera init ===
navigator.mediaDevices.getUserMedia({ video: true })
  .then(stream => {
    video.srcObject = stream;
    video.addEventListener('loadeddata', async () => {
      console.log("✅ Camera ready — starting emotion detection (smoothed).");
      // start detection loop and playback monitor
      startEmotionDetectionLoop();
      startPlaybackMonitor();
    });
  })
  .catch(err => {
    console.error("Camera error:", err);
    emotionText.textContent = "Camera error — allow camera and reload";
  });

// capture frame as base64
async function captureFrameBase64() {
  if (video.videoWidth === 0 || video.videoHeight === 0) throw new Error("camera not ready");
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg');
}

// small helper: call /analyze (we use it for emotion detection phase and for final track fetch)
async function callAnalyze(payload, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch('/analyze', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (err) {
      console.warn("callAnalyze attempt", attempt+1, "failed:", err);
      if (attempt === retries) throw err;
      await new Promise(res => setTimeout(res, 400));
    }
  }
}

// === Emotion detection loop (smoothed) ===
// We continuously send frames to /analyze to get emotion predictions.
// We keep a sliding window of recent emotions, compute the majority, and only commit when stable.
function startEmotionDetectionLoop() {
  // run first immediate detection
  runSingleDetectionCycle().catch(err => console.error("Initial detect error:", err));
  // then scheduled
  setInterval(() => {
    runSingleDetectionCycle().catch(err => console.error("detect cycle error:", err));
  }, 3000); // every 3 seconds — adjust if you like
}

async function runSingleDetectionCycle() {
  try {
    const frame = await captureFrameBase64();
    // Send small detection request. We expect server returns emotion+tracks; for smoothing we only use emotion now.
    const payload = { image: frame, mode: modeSelect.value, manual: null };
    const json = await callAnalyze(payload, 1);
    if (!json) return;
    const detected = (json.emotion || "neutral").toLowerCase();

    // update recentEmotions
    recentEmotions.push(detected);
    if (recentEmotions.length > EMOTION_HISTORY_LEN) recentEmotions.shift();

    // compute majority
    const counts = {};
    for (const e of recentEmotions) counts[e] = (counts[e] || 0) + 1;
    let top = null, topCount = 0;
    for (const k of Object.keys(counts)) {
      if (counts[k] > topCount) { top = k; topCount = counts[k]; }
    }

    // update tentative UI (we show current top but we don't queue until stable)
    emotionText.textContent = `Tentative: ${detected} (top: ${top} — ${topCount}/${recentEmotions.length})`;

    // decide whether stable: topCount >= EMOTION_REQUIRED
    const now = Date.now();
    if (top && topCount >= EMOTION_REQUIRED) {
      // don't re-commit too often
      if (top !== lastCommittedMood && (now - lastCommitTime) > MIN_RECOMMIT_MS) {
        console.log(`Stable mood confirmed: ${top} (count=${topCount}). Committing and fetching tracks.`);
        lastCommittedMood = top;
        lastCommitTime = now;
        // Commit: fetch tracks using manual override so server returns tracks for the confirmed mood
        await commitStableMoodAndQueue(top);
      } else {
        // Already committed recently; no-op
      }
    } else {
      // not stable yet; do not queue
    }

  } catch (err) {
    console.error("runSingleDetectionCycle error:", err);
  }
}

// When a mood is stable, request tracks from server and add to queue (dedup)
async function commitStableMoodAndQueue(mood) {
  try {
    // call /analyze with manual override so server returns tracks tailored to 'mood'
    const payload = { image: null, mode: modeSelect.value, manual: mood };
    const json = await callAnalyze(payload, 1);
    if (!json) return;
    const incoming = json.tracks || [];
    let added = 0;
    for (const t of incoming) {
      if (!t || !t.id) continue;
      if (currentTrack && currentTrack.id === t.id) continue;
      if (trackQueue.some(q => q.id === t.id)) continue;
      trackQueue.push(t);
      added++;
    }
    if (added > 0) {
      console.log(`Committed mood "${mood}" — added ${added} tracks; queue length now ${trackQueue.length}`);
      updateQueueUI();
      // if nothing is playing, start
      if (!currentTrack) {
        playNextWithCrossfade();
      }
    } else {
      console.log(`Committed mood "${mood}" — but no new tracks were added (maybe duplicates).`);
    }
    // update emotion UI to show committed mood
    emotionText.textContent = `Mood: ${mood}`;
  } catch (err) {
    console.error("commitStableMoodAndQueue error:", err);
  }
}

// === Queue UI ===
function updateQueueUI() {
  nextSongLabel.textContent = trackQueue.length > 0 ? `Next: ${trackQueue[0].title} — ${trackQueue[0].artist}` : "Next: —";
  queueList.innerHTML = trackQueue.map((t, i) => `<li>${i+1}. ${t.title} — ${t.artist}</li>`).join('') || "<li>(queue empty)</li>";
}

// preload idle audio
function preloadToIdle(url) {
  try {
    idleAudio.src = url;
    idleAudio.load();
  } catch (e) {
    console.warn("preload failed", e);
  }
}

// swap active/idle
function swapAudio() {
  const tmp = activeAudio;
  activeAudio = idleAudio;
  idleAudio = tmp;
}

// crossfade implementation
function crossfadeStart() {
  const duration = CROSSFADE_SECONDS;
  const steps = Math.round(duration * 60);
  let step = 0;
  idleAudio.volume = 0;
  const playPromise = idleAudio.play();
  if (playPromise && playPromise.catch) {
    playPromise.catch(e => {
      console.warn("idleAudio.play() failed in crossfade:", e);
    });
  }
  const iv = setInterval(() => {
    step++;
    const t = step / steps;
    activeAudio.volume = Math.max(0, 1 - t);
    idleAudio.volume = Math.min(1, t);
    if (step >= steps) {
      clearInterval(iv);
      try { activeAudio.pause(); } catch(e) {}
      activeAudio.currentTime = 0;
      swapAudio();
      activeAudio.volume = 1;
      idleAudio.volume = 1;
    }
  }, (duration * 1000) / steps);
}

// play next playable track from queue with crossfade
async function playNextWithCrossfade() {
  if (trackQueue.length === 0) {
    currentTrack = null;
    nowSongLabel.textContent = "Now: —";
    nextSongLabel.textContent = "Next: —";
    updateQueueUI();
    return;
  }

  const next = trackQueue.shift();
  currentTrack = next;
  updateQueueUI();

  // load into idleAudio
  idleAudio.src = next.file;
  // wait for canplay
  await new Promise((resolve) => {
    const onCan = () => { idleAudio.removeEventListener('canplay', onCan); idleAudio.removeEventListener('canplaythrough', onCan); resolve(); };
    idleAudio.addEventListener('canplay', onCan);
    idleAudio.addEventListener('canplaythrough', onCan);
    // safety timeout
    setTimeout(resolve, 2500);
  });

  // if nothing playing, simple start
  if (activeAudio.paused || activeAudio.currentTime === 0) {
    try {
      idleAudio.volume = 1;
      await idleAudio.play();
      swapAudio();
    } catch (e) {
      console.warn("Play failed on initial start:", e);
      swapAudio();
    }
  } else {
    crossfadeStart();
  }

  nowSongLabel.textContent = `Now: ${next.title} — ${next.artist}`;
  nextSongLabel.textContent = trackQueue.length > 0 ? `Next: ${trackQueue[0].title} — ${trackQueue[0].artist}` : "Next: —";

  // preload next
  if (trackQueue.length > 0) preloadToIdle(trackQueue[0].file);
}

// Monitor playback; trigger detection when ~10s left (handles fast-forward via seek)
function startPlaybackMonitor() {
  // ended fallback
  activeAudio.addEventListener('ended', () => {
    playNextWithCrossfade();
    if (trackQueue.length < 2) runSingleDetectionCycle().catch(e=>console.warn(e));
  });

  // periodic check
  setInterval(() => {
    try {
      if (!activeAudio || !currentTrack) return;
      const dur = activeAudio.duration;
      const cur = activeAudio.currentTime;
      if (!dur || isNaN(dur)) return;
      const timeLeft = dur - cur;
      if (timeLeft <= 10 && trackQueue.length < 2 && !fetchingNext) {
        // proactively trigger a detection cycle; the smoothing logic will commit when stable
        console.log("Time left <= 10s — triggering detection cycle");
        runSingleDetectionCycle().catch(err => console.error("late detect error:", err));
      }
    } catch (err) {
      console.warn("playback monitor error:", err);
    }
  }, CHECK_INTERVAL_MS);

  // also check on seeked events
  activeAudio.addEventListener('seeked', () => {
    try {
      const dur = activeAudio.duration;
      const cur = activeAudio.currentTime;
      if (!dur || isNaN(dur)) return;
      if ((dur - cur) <= 10 && trackQueue.length < 2 && !fetchingNext) {
        runSingleDetectionCycle().catch(err => console.error("seek detect error:", err));
      }
    } catch (err) {}
  });

  // audio error: skip to next
  activeAudio.addEventListener('error', (ev) => {
    console.warn("Audio error (activeAudio):", ev, activeAudio.error);
    playbackStatus.classList.remove('hidden');
    playbackStatus.textContent = "Playback error — skipping to next";
    setTimeout(() => {
      playbackStatus.classList.add('hidden');
      playNextWithCrossfade();
    }, 700);
  });
}

// expose skip for quick testing
window.skipTrack = () => {
  try { activeAudio.pause(); } catch(e){}
  playNextWithCrossfade();
};

// initial UI
updateQueueUI();
