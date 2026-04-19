# HealthGrid 🌍

Real-time environmental health risk monitoring tool built for SDG 3 — Good Health and Wellbeing.

HealthGrid pulls live weather and air quality data to compute health risk scores across a map grid, updated every 60 seconds. Click any location to get AI-powered public health insights specific to that area.

## Features
- Real-time risk grid for flu, air quality, and heat stress
- Color coded map: blue (low) → green → amber → red (severe)
- AI insights powered by Claude for any clicked location
- Auto-refreshes every 60 seconds
- Alert badge when severe conditions are detected in view

## Tech Stack
- **Frontend:** React, Mapbox GL JS
- **Backend:** Python, FastAPI
- **Data:** Open-Meteo (weather + air quality API)
- **AI:** Anthropic Claude

## Setup

### Requirements
- Node.js
- Python 3.9+
- Anthropic API key (console.anthropic.com)
- Mapbox API key (mapbox.com)

### Backend
```bash
cd backend
pip install fastapi uvicorn requests anthropic
```

Create a `.env` file in the backend folder:
ANTHROPIC_API_KEY=your_key_here
Run the backend:
```bash
python -m uvicorn main:app --reload
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`

## How It Works
1. The visible map is divided into an 8x5 grid of 40 cells
2. Each cell fetches real temperature and PM2.5 data from Open-Meteo
3. Risk scores (0.0 to 1.0) are computed per cell based on the selected mode
4. Claude AI generates location-specific insights when you click anywhere
5. Grid refreshes every 60 seconds automatically

## SDG Connection
This project addresses **SDG 3 — Good Health and Wellbeing**, specifically:
- Target 3.3: Reduce epidemic diseases
- Target 3.d: Strengthen early warning for health risks

Prevention is the most equitable form of healthcare. This tool requires no doctor, no hospital, no insurance — just information delivered to anyone with a phone.

## Limitations
- Grid resolution is coarse (40 cells)
- Risk formula is simplified, not clinically validated
- No historical trend data

## Future Work
- Finer grid with interpolation
- Incorporate humidity and population density into risk model
- Hospital and clinic overlay
- Mobile push alerts for severe conditions
