from flask import Flask, render_template, request, jsonify
from deepface import DeepFace
from spotify_fns import get_playlist_for_mood
import cv2
import numpy as np
import base64
import traceback
import os

app = Flask(__name__)

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/analyze', methods=['POST'])
@app.route("/analyze", methods=["POST"])
def analyze():
    try:
        data = request.get_json()
        mode = data.get("mode", "match")
        image_data = data.get("image", "")

        print("\n🟢 Incoming Request")
        print("Mode:", mode)
        print("Has image:", bool(image_data))
        print("Image data length:", len(image_data))
        print("Starts with:", image_data[:20])

        # Decode the base64 image
        if "," in image_data:
            image_data = image_data.split(",")[1]
        img_bytes = base64.b64decode(image_data)
        np_arr = np.frombuffer(img_bytes, np.uint8)
        frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)

        # Save frame temporarily to avoid DeepFace ndarray ambiguity
        temp_path = "temp_frame.jpg"
        cv2.imwrite(temp_path, frame)

        print("🔍 Running DeepFace analysis...")
        result = DeepFace.analyze(
            img_path=temp_path,
            actions=["emotion"],
            enforce_detection=False
        )

        # Clean up
        if os.path.exists(temp_path):
            os.remove(temp_path)

        # Extract emotion
        emotion = result[0]['dominant_emotion'] if isinstance(result, list) else result['dominant_emotion']
        print("✅ Detected Emotion:", emotion)

        # Get playlist
        playlist = get_playlist_for_mood(emotion)
        return jsonify({"emotion": emotion, "playlist": playlist})

    except Exception as e:
        print("❌ ERROR:", e)
        traceback.print_exc()
        return jsonify({"error": str(e)}), 500


if __name__ == '__main__':
    app.run(debug=True)
