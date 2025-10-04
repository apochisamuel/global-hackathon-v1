import requests
import base64
import json

CLIENT_ID = "884810547a5e42af9ca3c3a6619a67b8"
CLIENT_SECRET = "d5c5e5308ffd43a6b9c4e313cd826186"

def get_spotify_token():
    auth_str = f"{CLIENT_ID}:{CLIENT_SECRET}"
    b64_auth_str = base64.b64encode(auth_str.encode()).decode()
    response = requests.post(
        "https://accounts.spotify.com/api/token",
        headers={"Authorization": f"Basic {b64_auth_str}"},
        data={"grant_type": "client_credentials"}
    )
    return response.json().get("access_token")

def get_playlist_for_mood(mood):
    access_token = get_spotify_token()

    search_terms = {
        "happy": "happy vibes",
        "sad": "mellow acoustic",
        "angry": "rock anthems",
        "neutral": "chill hits",
        "surprise": "discover weekly",
        "fear": "focus calm",
        "disgust": "clean mood reset"
    }

    query = search_terms.get(mood, "chill mood")
    url = f"https://api.spotify.com/v1/search?q={query}&type=playlist&limit=1"

    response = requests.get(url, headers={"Authorization": f"Bearer {access_token}"})
    data = response.json()

    try:
        playlist_items = data.get('playlists', {}).get('items', [])
        if playlist_items:
            playlist_url = playlist_items[0]['external_urls']['spotify']
        else:
            print(f"⚠️ No playlists found for '{mood}', using fallback.")
            playlist_url = "https://open.spotify.com/embed/playlist/37i9dQZF1DX3rxVfibe1L0"  # fallback: Chill Hits
    except Exception as e:
        print(f"⚠️ Error parsing Spotify data: {e}")
        playlist_url = "https://open.spotify.com/embed/playlist/37i9dQZF1DX3rxVfibe1L0"

    embed_url = playlist_url.replace("open.spotify.com/", "open.spotify.com/embed/")
    return embed_url