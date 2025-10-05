// static/script.js — final combined version with gesture-unlock + playback

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
let trackQueue = [];
let currentTrack = null;

const EMOTION_HISTORY_LEN = 5;
const EMOTION_REQUIRED = 3;
let recentEmotions = [];
let lastCommittedMood = null;
let lastCommitTime = 0;
const MIN_RECOMMIT_MS = 6000;

const CHECK_INTERVAL_MS = 600;
const CROSSFADE_SECONDS = 2.0;

let preQueueLock = false;
let isDetecting = false;
let audioUnlocked = false;

// safe play/pause helper
async function safePlayThenPause(aud) {
  try {
    if (!aud || !aud.src) return;
    const p = aud.play();
    if (p && p.catch) {
      await p.catch(err => { throw err; });
    }
    aud.pause();
    aud.currentTime = 0;
  } catch (err) {
    throw err;
  }
}

function requestUserGesture(message = "Click or tap anywhere to enable audio") {
  if (userInteracted) return;
  playbackStatus.classList.remove('hidden');
  playbackStatus.textContent = message;
  audioHint.style.display = 'block';
  startBtn.disabled = false;
}

// Unlock logic that runs once on first real user gesture
async function unlockAudioGesture() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  userInteracted = true;

  const fallback = "/static/samples/neutral1.mp3";
  let addedTempSrc = false;
  try {
    if (!activeAudio.src) { activeAudio.src = fallback; addedTempSrc = true; }
    if (!idleAudio.src)   { idleAudio.src   = fallback; addedTempSrc = true; }

    await Promise.all([
      safePlayThenPause(activeAudio).catch(e=>console.warn('unlock active failed', e)),
      safePlayThenPause(idleAudio).catch(e=>console.warn('unlock idle failed', e))
    ]);
    console.log("Audio unlocked by user gesture");
    try { startBtn.disabled = true; startBtn.textContent = "Session started ✅"; } catch(e){}
    audioHint.style.display = 'none';
    playbackStatus.classList.add('hidden');
  } catch (e) {
    console.warn("unlockAudioGesture error:", e);
  } finally {
    if (addedTempSrc && !currentTrack && trackQueue.length === 0) {
      try { activeAudio.removeAttribute('src'); activeAudio.load(); } catch(e){}
      try { idleAudio.removeAttribute('src'); idleAudio.load(); } catch(e){}
    }
    removeGestureListeners();
  }
}


function removeGestureListeners() {
  ['pointerdown','touchstart','click','keydown'].forEach(ev => {
    document.removeEventListener(ev, boundUnlock, {passive:true});
  });
}

// bound function reference for add/remove
const boundUnlock = (ev) => {
  try { unlockAudioGesture(); } catch(e){ console.warn(e); }
};

// attach gesture listeners early
['pointerdown','touchstart','click','keydown'].forEach(ev => {
  document.addEventListener(ev, boundUnlock, {passive:true});
});

// start button also calls unlock
document.getElementById('startBtn').addEventListener('click', async () => {
    console.log("Start button clicked — bootstrapping happy track...");
    try {
        await commitStableMoodAndQueue('neutral', { force: true });
        await playNextWithCrossfade(); // start playback immediately
        console.log("Happy track added and playback started!");
    } catch (err) {
        console.error("Failed to enqueue/play happy track:", err);
    }
}, { once: true }); // only run once

// camera + detection startup
navigator.mediaDevices.getUserMedia({ video: true })
  .then(stream => {
    video.srcObject = stream;
    video.addEventListener('loadeddata', async () => {
      attachGlobalAudioListeners();
      startEmotionDetectionLoop();
      startPlaybackMonitor();
      console.log("Camera ready — detection and playback monitor started.");
    });
  })
  .catch(err => {
    console.error("Camera error:", err);
    emotionText.textContent = "Camera error — allow camera and reload";
  });

// capture frame
async function captureFrameBase64() {
  if (video.videoWidth === 0 || video.videoHeight === 0) throw new Error("camera not ready");
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg');
}

// call /analyze
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

// smoothing helper
function getTopFromRecent() {
  if (recentEmotions.length === 0) return null;
  const counts = {};
  for (const e of recentEmotions) counts[e] = (counts[e] || 0) + 1;
  let top = null, topCount = 0;
  for (const k of Object.keys(counts)) {
    if (counts[k] > topCount) { top = k; topCount = counts[k]; }
  }
  return top;
}

// detection loop
function startEmotionDetectionLoop() {
  runSingleDetectionCycle().catch(err => console.error("Initial detect error:", err));
  setInterval(() => {
    runSingleDetectionCycle().catch(err => console.error("detect cycle error:", err));
  }, 3000);
}

async function runSingleDetectionCycle() {
  if (isDetecting) return;
  isDetecting = true;
  try {
    const frame = await captureFrameBase64();
    const payload = { image: frame, mode: modeSelect.value, manual: null };
    const json = await callAnalyze(payload, 1);
    if (!json) return;
    const detected = (json.emotion || "neutral").toLowerCase();

    recentEmotions.push(detected);
    if (recentEmotions.length > EMOTION_HISTORY_LEN) recentEmotions.shift();

    const counts = {};
    for (const e of recentEmotions) counts[e] = (counts[e] || 0) + 1;
    let top = null, topCount = 0;
    for (const k of Object.keys(counts)) {
      if (counts[k] > topCount) { top = k; topCount = counts[k]; }
    }

    emotionText.textContent = `Tentative: ${detected} (top: ${top} — ${topCount}/${recentEmotions.length})`;

    const now = Date.now();
    if (top && topCount >= EMOTION_REQUIRED) {
      if (top !== lastCommittedMood && (now - lastCommitTime) > MIN_RECOMMIT_MS) {
        lastCommittedMood = top;
        lastCommitTime = now;
        await commitStableMoodAndQueue(top, {force:false});
      }
    }
  } catch (err) {
    console.error("runSingleDetectionCycle error:", err);
  } finally {
    isDetecting = false;
  }
}

// commit mood -> queue
async function commitStableMoodAndQueue(mood, options = {}) {
  const force = !!options.force;
  try {
    if (!force) {
      if (!mood) return;
      const now = Date.now();
      if (mood === lastCommittedMood && (now - lastCommitTime) < MIN_RECOMMIT_MS) return;
    }

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
      updateQueueUI();
      if (!currentTrack) {
        await unlockAudioGesture(); // ensure unlocked if user hasn't interacted
        await startPlaybackOrPrompt();
        await playNextWithCrossfade();
      }
    }
    emotionText.textContent = `Mood: ${mood}`;
    lastCommittedMood = mood;
    lastCommitTime = Date.now();
  } catch (err) {
    console.error("commitStableMoodAndQueue error:", err);
  }
}

// playback helpers
function updateQueueUI() {
  nextSongLabel.textContent = trackQueue.length > 0 ? `Next: ${trackQueue[0].title} — ${trackQueue[0].artist}` : "Next: —";
  queueList.innerHTML = trackQueue.map((t, i) => `<li>${i+1}. ${t.title} — ${t.artist}</li>`).join('') || "<li>(queue empty)</li>";
}

function preloadToIdle(url) {
  try {
    if (!url) return;
    idleAudio.src = url;
    idleAudio.load();
  } catch (e) { console.warn("preload failed", e); }
}

function swapAudio() {
  const tmp = activeAudio;
  activeAudio = idleAudio;
  idleAudio = tmp;
}

function crossfadeStart() {
  const duration = CROSSFADE_SECONDS;
  const steps = Math.round(duration * 60);
  let step = 0;
  idleAudio.volume = 0;
  const playPromise = idleAudio.play();
  if (playPromise && playPromise.catch) {
    playPromise.catch(e => {
      console.warn("idleAudio.play() failed in crossfade:", e);
      if (e.name === "NotAllowedError" || e.name === "NotSupportedError") {
        requestUserGesture("Click or tap anywhere to enable audio");
      }
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

  idleAudio.src = next.file;
  await new Promise((resolve) => {
    let resolved = false;
    const onCan = () => { if (!resolved) { resolved = true; idleAudio.removeEventListener('canplay', onCan); idleAudio.removeEventListener('canplaythrough', onCan); resolve(); } };
    idleAudio.addEventListener('canplay', onCan);
    idleAudio.addEventListener('canplaythrough', onCan);
    setTimeout(() => { if (!resolved) { resolved = true; resolve(); } }, 2500);
  });

  if (activeAudio.paused || activeAudio.currentTime === 0) {
    try {
      await attemptPlay(idleAudio);
      swapAudio();
    } catch (e) {
      console.warn("Play failed on initial start:", e);
      requestUserGesture("Click or tap anywhere to enable audio");
      swapAudio();
    }
  } else {
    crossfadeStart();
  }

  nowSongLabel.textContent = `Now: ${next.title} — ${next.artist}`;
  nextSongLabel.textContent = trackQueue.length > 0 ? `Next: ${trackQueue[0].title} — ${trackQueue[0].artist}` : "Next: —";

  if (trackQueue.length > 0) preloadToIdle(trackQueue[0].file);
}

async function attemptPlay(aud) {
  if (!aud || !aud.src) throw new Error("no-src");
  const p = aud.play();
  if (p && p.catch) {
    return await p.catch(err => { throw err; });
  }
  return p;
}

async function startPlaybackOrPrompt() {
  try {
    if (!activeAudio.paused && activeAudio.currentTime > 0 && !activeAudio.ended) return;
    if (audioUnlocked) return;
    if (activeAudio.src) {
      await attemptPlay(activeAudio);
      activeAudio.pause();
      return;
    }
    if (idleAudio.src) {
      try {
        await attemptPlay(idleAudio);
        idleAudio.pause();
        return;
      } catch(e) {
        console.warn("startPlaybackOrPrompt: idleAudio play failed", e);
      }
    }
    requestUserGesture("Click or tap anywhere to enable audio");
  } catch (e) {
    console.warn("Autoplay blocked or startPlaybackOrPrompt error:", e);
    requestUserGesture("Click or tap anywhere to enable audio");
  }
}

// audio listeners
function attachGlobalAudioListeners() {
  [audioA, audioB].forEach(aud => {
    aud.addEventListener('ended', () => {
      playNextWithCrossfade();
      if (trackQueue.length < 2) runSingleDetectionCycle().catch(e => console.warn(e));
    });

    aud.addEventListener('error', (ev) => {
      console.warn("Audio element error:", ev, aud.error);
      playbackStatus.classList.remove('hidden');
      playbackStatus.textContent = "Playback error — skipping to next";
      setTimeout(() => { playbackStatus.classList.add('hidden'); playNextWithCrossfade(); }, 700);
    });

    aud.addEventListener('seeked', (ev) => {
      try {
        const dur = aud.duration;
        const cur = aud.currentTime;
        if (!dur || isNaN(dur)) return;
        if (aud === activeAudio && (dur - cur) <= 10 && trackQueue.length < 2 && !preQueueLock) {
          triggerPrequeueBasedOnLatest();
        }
      } catch (err) {}
    });
  });
}

function startPlaybackMonitor() {
  setInterval(() => {
    try {
      if (!activeAudio || !currentTrack) return;
      const dur = activeAudio.duration;
      const cur = activeAudio.currentTime;
      if (!dur || isNaN(dur)) return;
      const timeLeft = dur - cur;
      if (timeLeft <= 10 && trackQueue.length < 2 && !preQueueLock) {
        triggerPrequeueBasedOnLatest();
      }
    } catch (err) {
      console.warn("playback monitor error:", err);
    }
  }, CHECK_INTERVAL_MS);
}

async function triggerPrequeueBasedOnLatest() {
  if (preQueueLock) return;
  preQueueLock = true;
  try {
    const top = getTopFromRecent() || lastCommittedMood || "neutral";
    await commitStableMoodAndQueue(top, {force: true});
  } catch (err) {
    console.warn("triggerPrequeueBasedOnLatest error:", err);
  } finally {
    preQueueLock = false;
  }
}

// debug skip
window.skipTrack = () => {
  try { activeAudio.pause(); } catch(e){}
  playNextWithCrossfade();
};

// expose functions
window.commitStableMoodAndQueue = commitStableMoodAndQueue;
window.playNextWithCrossfade = playNextWithCrossfade;

// initial UI
function updateQueueUI() {
  nextSongLabel.textContent = trackQueue.length > 0 ? `Next: ${trackQueue[0].title} — ${trackQueue[0].artist}` : "Next: —";
  queueList.innerHTML = trackQueue.map((t, i) => `<li>${i+1}. ${t.title} — ${t.artist}</li>`).join('') || "<li>(queue empty)</li>";
}
updateQueueUI();
