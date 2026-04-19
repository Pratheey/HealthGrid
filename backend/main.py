from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import requests
import anthropic
from concurrent.futures import ThreadPoolExecutor
import time

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

anthropic_client = anthropic.Anthropic(api_key="ANTHROPIC_API_KEY")  # Replace with your Anthropic API key

_cache = {}
CACHE_TTL = 60


def safe_get(url, params, retries=2, timeout=10):
    for attempt in range(retries):
        try:
            r = requests.get(url, params=params, timeout=timeout)
            return r
        except Exception as e:
            if attempt == retries - 1:
                print(f"Failed after {retries} attempts: {e}")
    return None


def fetch_cell(lat, lng, mode):
    cache_key = f"{round(lat,2)},{round(lng,2)},{mode}"
    now = time.time()

    if cache_key in _cache:
        ts, val = _cache[cache_key]
        if now - ts < CACHE_TTL:
            return val

    temp, pm25 = 20.0, 10.0

    r = safe_get(
        "https://api.open-meteo.com/v1/forecast",
        {"latitude": lat, "longitude": lng, "current_weather": "true"},
    )
    if r:
        temp = r.json().get("current_weather", {}).get("temperature", 20.0)

    if mode == "air":
        r = safe_get(
            "https://air-quality-api.open-meteo.com/v1/air-quality",
            {"latitude": lat, "longitude": lng, "hourly": "pm2_5"},
        )
        if r:
            pm25_list = r.json().get("hourly", {}).get("pm2_5", [])
            pm25 = next((v for v in pm25_list if v is not None), 10.0)

    if mode == "flu":
        risk = max(0.0, min(1.0, (30 - temp) / 30))
    elif mode == "air":
        risk = max(0.0, min(1.0, pm25 / 50))
    else:
        risk = max(0.0, min(1.0, temp / 45))

    _cache[cache_key] = (now, risk)
    return risk


@app.get("/grid")
def get_grid(
    mode: str = "flu",
    north: float = 40,
    south: float = 30,
    east: float = -110,
    west: float = -130,
    cols: int = 8,
    rows: int = 5,
):
    lat_step = (north - south) / rows
    lng_step = (east - west) / cols

    cells = []
    for row in range(rows):
        for col in range(cols):
            cell_south = south + row * lat_step
            cell_north = cell_south + lat_step
            cell_west = west + col * lng_step
            cell_east = cell_west + lng_step
            center_lat = (cell_south + cell_north) / 2
            center_lng = (cell_west + cell_east) / 2
            cells.append((row, col, center_lat, center_lng, cell_south, cell_north, cell_west, cell_east))

    def fetch(cell):
        row, col, clat, clng, cs, cn, cw, ce = cell
        risk = fetch_cell(clat, clng, mode)
        return {
            "row": row, "col": col,
            "risk": risk,
            "bounds": {"south": cs, "north": cn, "west": cw, "east": ce},
        }

    with ThreadPoolExecutor(max_workers=10) as ex:
        results = list(ex.map(fetch, cells))

    return results


@app.get("/insights")
def insights(
    mode: str = "flu",
    lat: float = 34,
    lng: float = -118,
    location: str = "this location",
):
    temp, pm25 = 20.0, 10.0

    r = safe_get(
        "https://api.open-meteo.com/v1/forecast",
        {"latitude": lat, "longitude": lng, "current_weather": "true"},
    )
    if r:
        temp = r.json().get("current_weather", {}).get("temperature", 20.0)

    r = safe_get(
        "https://air-quality-api.open-meteo.com/v1/air-quality",
        {"latitude": lat, "longitude": lng, "hourly": "pm2_5"},
    )
    if r:
        pm25_list = r.json().get("hourly", {}).get("pm2_5", [])
        pm25 = next((v for v in pm25_list if v is not None), 10.0)

    if mode == "flu":
        risk = max(0.0, min(1.0, (30 - temp) / 30))
        risk_label = "High" if risk > 0.65 else "Moderate" if risk > 0.35 else "Low"
        context = f"temperature is {temp:.1f}°C and flu risk is {risk_label} ({risk:.0%})"
        focus = "flu transmission risk, how temperature affects virus survival, and any precautions people should take"
    elif mode == "air":
        risk = max(0.0, min(1.0, pm25 / 50))
        risk_label = "Unhealthy" if risk > 0.65 else "Moderate" if risk > 0.35 else "Good"
        context = f"PM2.5 is {pm25:.1f} µg/m³ and air quality is {risk_label}"
        focus = "air quality health impacts, who is most at risk, and what people should do"
    else:
        risk = max(0.0, min(1.0, temp / 45))
        risk_label = "Extreme" if risk > 0.75 else "High" if risk > 0.5 else "Moderate" if risk > 0.25 else "Low"
        context = f"temperature is {temp:.1f}°C and heat risk is {risk_label}"
        focus = "heat health risks, vulnerable populations, and cooling strategies"

    prompt = (
        f"You are a public health analyst. "
        f"Current conditions in {location}: {context}. "
        f"Write exactly 3 bullet points. One emoji each. Max 10 words each. No markdown, no bold, no headers. "
        f"Bullet 1: something specific about {location} that affects {mode} risk. "
        f"Bullet 2: a short alert-style status, like a weather service. "
        f"Bullet 3: how {location} compares to typical conditions this time of year. "
        f"Plain text only."
    )

    def stream():
        with anthropic_client.messages.stream(
            model="claude-haiku-4-5-20251001",
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        ) as s:
            for text in s.text_stream:
                yield text

    return StreamingResponse(stream(), media_type="text/plain")