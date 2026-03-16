FROM python:3.9-slim

# Alapvető rendszerkönyvtárak az audio feldolgozáshoz (libsndfile)
RUN apt-get update && apt-get install -y libsndfile1 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Függőségek másolása és telepítése
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Kód másolása
COPY worker.py .

# Indítás
CMD ["python", "-u", "worker.py"]