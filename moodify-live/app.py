# app.py
import os
import json
import base64
import tempfile
import traceback
from flask import Flask, render_template, request, jsonify, url_for
try:
    from deepface import DeepFace
    DEEPFACE_AVAILABLE = True
except Exception:
    DEEPFACE_AVAILABLE = False

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

# Normalizer & validator
def normalize_and_validate_manifest(manifest, static_folder):
    fixed = []
    warnings = []
    for entry in manifest:
        e = dict(entry)
        moods = e.get("moods", [])
        if isinstance(moods, str):
            moods_list = [m.strip().lower() for m in moods.split(',') if m.strip()]
        elif isinstance(moods, list):
            moods_list = [str(m).strip().lower() for m in moods if str(m).strip()]
        else:
            moods_list = []
        e['moods'] = moods_list

        raw_file = e.get("file", "")
        candidate = None
        if raw_file:
            if raw_file.startswith("http://") or raw_file.startswith("https://"):
                candidate = None
            elif raw_file.startswith("/"):
                rel = raw_file.lstrip("/")
                if rel.startswith("static/"):
                    rel = rel[len("static/"):]
                candidate = os.path.join(static_folder, rel)
            else:
                candidate = os.path.join(static_folder, "samples", raw_file)

            if candidate and not os.path.exists(candidate):
                warnings.append(f"Missing file for manifest entry id={e.get('id')}: expected {candidate}")

        fixed.append(e)
    return fixed, warnings

TRACKS_MANIFEST, manifest_warnings = normalize_and_validate_manifest(TRACKS_MANIFEST, app.static_folder)
for w in manifest_warnings:
    print("⚠️ manifest warning:", w)

def get_local_tracks_for_mood(mood, limit=2):
    mood = (mood or "neutral").lower()
    matches = [t for t in TRACKS_MANIFEST if mood in [m.lower() for m in t.get("moods", [])]]
    if len(matches) < limit:
        neutral = [t for t in TRACKS_MANIFEST if "neutral" in [m.lower() for m in t.get("moods", [])]]
        for n in neutral:
            if n not in matches:
                matches.append(n)
            if len(matches) >= limit:
                break
    if len(matches) < limit:
        for t in TRACKS_MANIFEST:
            if t not in matches:
                matches.append(t)
            if len(matches) >= limit:
                break

    out = []
    seen = set()
    for t in matches[:limit]:
        tid = t.get("id") or t.get("file")
        if tid in seen:
            continue
        seen.add(tid)
        raw_file = t.get("file", "")
        if raw_file.startswith("http://") or raw_file.startswith("https://") or raw_file.startswith("/"):
            file_url = raw_file
        else:
            try:
                file_url = url_for('static', filename=f"samples/{raw_file}")
            except Exception:
                file_url = f"/static/samples/{raw_file}"
        out.append({
            "id": tid,
            "title": t.get("title", "Unknown"),
            "artist": t.get("artist", "Local"),
            "file": file_url,
        })
    return out

@app.route("/get_local_tracks")
def get_local_tracks():
    mood = request.args.get("mood")
    tracks = get_local_tracks_for_mood(mood)
    return jsonify({"tracks": tracks})

def detect_emotion_from_base64(image_b64):
    if not DEEPFACE_AVAILABLE:
        return "neutral"
    try:
        if not image_b64:
            return "neutral"
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
            result = DeepFace.analyze(img_path=tf.name, actions=["emotion"], enforce_detection=False)
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
    try:
        data = request.get_json(force=True)
        image_data = data.get("image")
        manual = data.get("manual")
        mode = data.get("mode", "match")
        image_len = len(image_data) if isinstance(image_data, str) else (0 if image_data is None else 1)
        print("🟢 /analyze called — manual:", manual, "mode:", mode, "image_len:", image_len)

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

        tracks = get_local_tracks_for_mood(mood, limit=2)
        print(f"🟢 Returning {len(tracks)} local tracks for mood '{mood}'")
        return jsonify({"emotion": mood, "tracks": tracks})
    except Exception as e:
        print("❌ /analyze error:", e)
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500

# Prebuild DeepFace model on startup (optional)
if DEEPFACE_AVAILABLE:
    try:
        print("⏳ Pre-building DeepFace emotion model...")
        DeepFace.build_model("Emotion")
        print("✅ DeepFace emotion model ready.")
    except Exception as e:
        print("⚠️ Could not pre-build DeepFace model:", e)
else:
    print("ℹ️ DeepFace not available — emotion detection will default to 'neutral' for demo.")

if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", 5000))  # Render provides PORT
    app.run(host="0.0.0.0", port=port, debug=True)
