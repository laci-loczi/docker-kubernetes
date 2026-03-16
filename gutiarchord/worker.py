import os
import json
import base64
import tempfile
import redis
import time
from basic_pitch.inference import predict

# Kapcsolódás a meglévő Redis-hez a K8s klaszteren belül
REDIS_HOST = os.getenv('REDIS_HOST', 'redis-service')
print(f"[GUITAR-WORKER] Kapcsolódás a Redis-hez: {REDIS_HOST}...")

r = redis.Redis(host=REDIS_HOST, port=6379, db=0)

def process_audio(task_id, base64_audio):
    print(f"[GUITAR-WORKER] Feladat megkapva: {task_id}. AI elemzés indítása...")
    
    # 1. Base64 dekódolása és ideiglenes WAV fájlba mentése
    audio_data = base64.b64decode(base64_audio.split(',')[1] if ',' in base64_audio else base64_audio)
    
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_audio:
        temp_audio.write(audio_data)
        temp_audio_path = temp_audio.name

    try:
        # 2. Spotify Basic-Pitch AI futtatása a fájlon
        # Visszaadja a hangokat (pitch, kezdőidő, végidő, hangerő)
        model_output, midi_data, note_events = predict(temp_audio_path)
        
        # 3. Adatok formázása JSON-ba a Node.js és a Frontend számára
        notes_list = []
        for note in note_events:
            notes_list.append({
                "start_time": round(note[0], 3), # Másodpercben
                "end_time": round(note[1], 3),
                "pitch": note[2],                # MIDI hangmagasság (pl. 60 = Középső C)
                "amplitude": round(note[3], 3)   # Hangerő / Dinamika
            })
            
        # 4. Eredmény visszaküldése a Redis Pub/Sub-on
        result = {
            "taskId": task_id,
            "notes": notes_list,
            "workerName": "Python-Guitar-AI"
        }
        r.publish(f'guitar_result_{task_id}', json.dumps(result))
        print(f"[GUITAR-WORKER] Kész! {len(notes_list)} hangjegy felismerve.")
        
    except Exception as e:
        print(f"[GUITAR-WORKER] Hiba történt: {e}")
        r.publish(f'guitar_result_{task_id}', json.dumps({"error": str(e)}))
    finally:
        # Ideiglenes fájl törlése
        if os.path.exists(temp_audio_path):
            os.remove(temp_audio_path)

# Végtelen ciklus: Várakozás a feladatokra
print("[GUITAR-WORKER] AI modell betöltve. Várakozás gitár sávokra...")
while True:
    try:
        # Kiveszünk egy feladatot a 'guitar_tasks' sorból
        task_raw = r.brpop('guitar_tasks', timeout=5)
        if task_raw:
            task = json.loads(task_raw[1].decode('utf-8'))
            process_audio(task['taskId'], task['audioBase64'])
    except Exception as e:
        print(f"[GUITAR-WORKER] Redis hiba: {e}")
        time.sleep(2)