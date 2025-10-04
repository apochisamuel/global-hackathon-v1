# app.py
import os
import time
import json
import base64
import tempfile
import traceback
from flask import Flask, render_template, request, jsonify
from deepface import DeepFace

app = Flask(__name__)

# Path to manifest
MANIFEST_PATH = os.path.join(os.path.dirname(__file__), "static", "samples", "tracks.json")

# Load manifest at startup
try:
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        TRACKS_MANIFEST = json.load(f)
    print(f"Loaded {len(TRACKS_MANIFEST)} local sample tracks from {MANIFEST_PATH}")
except Exception as e:
    print("❌ Could not load tracks manifest:", e)
    TRACKS_MANIFEST = []

def get_local_tracks_for_mood(mood, limit=6):
    """Return list of local tracks matching mood (files are served from /static/samples/)."""
    mood = (mood or "neutral").lower()
    # prefer exact mood tag matches
    matches = [t for t in TRACKS_MANIFEST if mood in [m.lower() for m in t.get("moods", [])]]
    # if not enough, include neutral tracks
    if len(matches) < limit:
        neutral = [t for t in TRACKS_MANIFEST if "neutral" in [m.lower() for m in t.get("moods", [])]]
        # append neutral only those not already in matches
        for n in neutral:
            if n not in matches:
                matches.append(n)
            if len(matches) >= limit:
                break
    # if still not enough, return the first N tracks
    if len(matches) < limit:
        for t in TRACKS_MANIFEST:
            if t not in matches:
                matches.append(t)
            if len(matches) >= limit:
                break

    # format response objects
    out = []
    seen = set()
    for t in matches[:limit]:
        tid = t.get("id") or t.get("file")
        if tid in seen: 
            continue
        seen.add(tid)
        out.append({
            "id": tid,
            "title": t.get("title", "Unknown"),
            "artist": t.get("artist", "Local"),
            # file field is local path (browser will request http://host/static/samples/...)
            "file": t.get("file"),
        })
    return out

def detect_emotion_from_base64(image_b64):
    """Decode base64, write temporary image file, call DeepFace.analyze and return dominant_emotion."""
    try:
        if not image_b64:
            return "neutral"
        # image_b64 may be "data:image/jpeg;base64,...."
        if "," in image_b64:
            _, encoded = image_b64.split(",", 1)
        else:
            encoded = image_b64
        img_bytes = base64.b64decode(encoded)
        tf = tempfile.NamedTemporaryFile(suffix=".jpg", delete=False)
        try:
            tf.write(img_bytes)
            tf.flush()
            tf.close()
            # DeepFace works well with a file path
            result = DeepFace.analyze(img_path=tf.name, actions=["emotion"], enforce_detection=False)
            # DeepFace.analyze may return list or dict depending on version
            emo = "neutral"
            if isinstance(result, list) and len(result) > 0:
                emo = result[0].get("dominant_emotion", "neutral")
            elif isinstance(result, dict):
                emo = result.get("dominant_emotion", "neutral")
            return (emo or "neutral").lower()
        finally:
            try:
                os.remove(tf.name)
            except Exception:
                pass
    except Exception as e:
        print("⚠️ DeepFace analyze error:", e)
        traceback.print_exc()
        return "neutral"

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/analyze", methods=["POST"])
def analyze():
    """Receive {image: base64, manual: optional override, mode: match|lift} and return local tracks."""
    try:
        data = request.get_json(force=True)
        image_data = data.get("image")
        manual = data.get("manual")
        mode = data.get("mode", "match")
        print("🟢 /analyze called — manual:", manual, "mode:", mode, "image_len:", len(image_data) if image_data else 0)

        if manual and isinstance(manual, str) and manual.strip() != "":
            mood = manual.strip().lower()
            print("🟢 Using manual override mood:", mood)
        else:
            mood = detect_emotion_from_base64(image_data)
            print("🟢 Detected mood:", mood)
            if mode == "lift":
                mapping = {"sad": "happy", "angry": "neutral", "fear": "neutral", "disgust": "neutral", "surprise": "happy"}
                mood = mapping.get(mood, mood)
                print("🟢 After lift mapping mood:", mood)

        tracks = get_local_tracks_for_mood(mood, limit=6)
        print(f"🟢 Returning {len(tracks)} local tracks for mood '{mood}'")
        return jsonify({"emotion": mood, "tracks": tracks})
    except Exception as e:
        print("❌ /analyze error:", e)
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# Prebuild DeepFace model on startup
try:
    print("⏳ Pre-building DeepFace emotion model (this may take a moment)...")
    DeepFace.build_model("Emotion")
    print("✅ DeepFace emotion model ready.")
except Exception as e:
    print("⚠️ Could not pre-build DeepFace model:", e)
    traceback.print_exc()

if __name__ == "__main__":
    app.run(debug=True)
