import requests
import base64
from flask import Flask, request, jsonify
from deepface import DeepFace
import tempfile
import base64 as b64
import cv2
import numpy as np

app = Flask(__name__)

CLIENT_ID = "884810547a5e42af9ca3c3a6619a67b8"
CLIENT_SECRET = "d5c5e5308ffd43a6b9c4e313cd826186"

# ---------------------------------------------
# 🔑 Spotify Auth
# ---------------------------------------------
def get_spotify_token():
    auth_str = f"{CLIENT_ID}:{CLIENT_SECRET}"
    b64_auth_str = base64.b64encode(auth_str.encode()).decode()
    response = requests.post(
        "https://accounts.spotify.com/api/token",
        headers={"Authorization": f"Basic {b64_auth_str}"},
        data={"grant_type": "client_credentials"}
    )
    return response.json().get("access_token")


# ---------------------------------------------
# 🎧 Get Mood-Based Tracks
# ---------------------------------------------
def get_tracks_for_mood(mood, limit=8):
    access_token = get_spotify_token()

    search_terms = {
        "happy": "upbeat happy",
        "sad": "slow acoustic",
        "angry": "rock anthems",
        "neutral": "chill vibes",
        "surprise": "fresh finds",
        "fear": "calm focus",
        "disgust": "clean instrumental"
    }

    query = search_terms.get(mood, "chill mood")
    url = f"https://api.spotify.com/v1/search?q={query}&type=track&limit={limit}"

    try:
        response = requests.get(url, headers={"Authorization": f"Bearer {access_token}"})
        data = response.json()

        tracks = data.get("tracks", {}).get("items", [])
        track_list = []
        for track in tracks:
            # prefer tracks that expose a preview_url (mp3 snippet)
            if not track.get("preview_url"):
                # skip tracks without preview_url (can't be played via <audio>)
                continue
            track_list.append({
                "id": track["id"],
                "title": track["name"],
                "artist": ", ".join([a["name"] for a in track["artists"]]),
                "preview_url": track["preview_url"],
                "spotify_url": track["external_urls"]["spotify"]
            })

        # fallback: if no tracks with preview_url found, return empty list
        return track_list

    except Exception as e:
        print(f"⚠️ Error fetching tracks: {e}")
        return []



# ---------------------------------------------
# 🧠 Emotion Detection (DeepFace)
# ---------------------------------------------
def detect_emotion_from_image(image_data):
    try:
        header, encoded = image_data.split(",", 1)
        image_bytes = b64.b64decode(encoded)
        np_arr = np.frombuffer(image_bytes, np.uint8)
        img = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

        analysis = DeepFace.analyze(img, actions=['emotion'], enforce_detection=False)
        return analysis[0]['dominant_emotion']
    except Exception as e:
        print(f"⚠️ DeepFace error: {e}")
        return "neutral"


# ---------------------------------------------
# 🌐 API Endpoint
# ---------------------------------------------
@app.route("/analyze", methods=["POST"])
def analyze():
    data = request.get_json()
    image_data = data.get("image")
    manual_mood = data.get("manual")

    if manual_mood:
        mood = manual_mood.lower()
    else:
        mood = detect_emotion_from_image(image_data)

    tracks = get_tracks_for_mood(mood)
    return jsonify({"emotion": mood, "tracks": tracks})


if __name__ == "__main__":
    app.run(debug=True)
