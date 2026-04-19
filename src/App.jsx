import { useEffect, useRef, useState, useCallback } from "react";
import mapboxgl from "mapbox-gl";
import axios from "axios";
import "mapbox-gl/dist/mapbox-gl.css";

mapboxgl.accessToken = "MAPBOX_ACCESS_TOKEN"; // Replace with your Mapbox token

const BASE_URL = "http://127.0.0.1:8000";
const GRID_COLS = 8;
const GRID_ROWS = 5;
const REFRESH_MS = 60_000;
const ALERT_THRESHOLD = 0.8;

const MODE_CONFIG = {
  flu:  { label: "FLU",  icon: "🤧", accent: "#38bdf8" },
  air:  { label: "AIR",  icon: "🌫️", accent: "#a78bfa" },
  heat: { label: "HEAT", icon: "🔥", accent: "#fb923c" },
};

export default function App() {
  const mapRef      = useRef(null);
  const mapInstance = useRef(null);
  const timerRef    = useRef(null);
  const modeRef     = useRef("flu");
  const lastLatRef  = useRef(null);
  const lastLngRef  = useRef(null);

  const [mode,         setMode]         = useState("flu");
  const [loaded,       setLoaded]       = useState(false);
  const [insights,     setInsights]     = useState([]);
  const [insightTitle, setInsightTitle] = useState(null);
  const [fetching,     setFetching]     = useState(false);
  const [alert,        setAlert]        = useState(false);

  useEffect(() => { modeRef.current = mode; }, [mode]);

  // ── Grid fetch ────────────────────────────────────────────────────
  const fetchGrid = useCallback(async (map, currentMode) => {
    if (!map || !map.isStyleLoaded()) return;
    const { _ne: ne, _sw: sw } = map.getBounds();
    setFetching(true);

    try {
      const res = await axios.get(`${BASE_URL}/grid`, {
        params: {
          mode:  currentMode,
          north: ne.lat, south: sw.lat,
          east:  ne.lng, west:  sw.lng,
          cols:  GRID_COLS, rows: GRID_ROWS,
        },
      });

      // Check for alert threshold
      const maxRisk = Math.max(...res.data.map(c => c.risk));
      setAlert(maxRisk >= ALERT_THRESHOLD);

      const geojson = {
        type: "FeatureCollection",
        features: res.data.map(cell => ({
          type: "Feature",
          properties: { risk: cell.risk },
          geometry: {
            type: "Polygon",
            coordinates: [[
              [cell.bounds.west, cell.bounds.south],
              [cell.bounds.east, cell.bounds.south],
              [cell.bounds.east, cell.bounds.north],
              [cell.bounds.west, cell.bounds.north],
              [cell.bounds.west, cell.bounds.south],
            ]],
          },
        })),
      };

      if (map.getSource("grid")) {
        map.getSource("grid").setData(geojson);
      } else {
        map.addSource("grid", { type: "geojson", data: geojson });

        map.addLayer({
          id: "grid-fill",
          type: "fill",
          source: "grid",
          paint: {
            "fill-color": [
              "interpolate", ["linear"], ["get", "risk"],
              0.00, "#3b82f6",
              0.25, "#22c55e",
              0.50, "#f59e0b",
              0.75, "#ef4444",
              1.00, "#b91c1c",
            ],
            "fill-opacity": [
              "interpolate", ["linear"], ["get", "risk"],
              0, 0.15,
              1, 0.45,
            ],
          },
        });

        map.addLayer({
          id: "grid-stroke",
          type: "line",
          source: "grid",
          paint: {
            "line-color": "rgba(255,255,255,0.08)",
            "line-width": 0.5,
          },
        });
      }
    } catch (e) {
      console.error("Grid fetch error:", e);
    } finally {
      setFetching(false);
    }
  }, []);

  // ── Insights fetch (streaming) ────────────────────────────────────
  const fetchInsights = useCallback(async (lat, lng, placeName, currentMode) => {
    setInsightTitle(placeName);
    setInsights([]);

    try {
      const res = await fetch(
        `${BASE_URL}/insights?mode=${currentMode}&lat=${lat}&lng=${lng}&location=${encodeURIComponent(placeName)}`
      );

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        setInsights([accumulated]);
      }
    } catch (e) {
      setInsights(["⚠️ Could not load insights for this location."]);
    }
  }, []);

  // ── Auto-refresh insights when mode changes ───────────────────────
  useEffect(() => {
    if (!insightTitle || lastLatRef.current === null) return;
    fetchInsights(lastLatRef.current, lastLngRef.current, insightTitle, mode);
  }, [mode]);

  // ── Map init (once) ───────────────────────────────────────────────
  useEffect(() => {
    const map = new mapboxgl.Map({
      container: mapRef.current,
      style: "mapbox://styles/mapbox/dark-v11",
      center: [-119, 36],
      zoom: 5,
    });
    mapInstance.current = map;

    map.on("load", () => {
      setLoaded(true);
      fetchGrid(map, modeRef.current);
      map.on("moveend", () => fetchGrid(map, modeRef.current));
      timerRef.current = setInterval(
        () => fetchGrid(map, modeRef.current),
        REFRESH_MS
      );
    });

    map.on("click", async (e) => {
      const { lng, lat } = e.lngLat;
      let placeName = `${lat.toFixed(2)}, ${lng.toFixed(2)}`;

      try {
        const geo = await axios.get(
          `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json`,
          { params: { access_token: mapboxgl.accessToken, types: "place,region" } }
        );
        placeName = geo.data.features?.[0]?.place_name?.split(",")[0] ?? placeName;
      } catch (_) {}

      lastLatRef.current = lat;
      lastLngRef.current = lng;
      fetchInsights(lat, lng, placeName, modeRef.current);
    });

    return () => {
      clearInterval(timerRef.current);
      map.remove();
    };
  }, [fetchGrid, fetchInsights]);

  // ── Re-fetch grid on mode change ──────────────────────────────────
  useEffect(() => {
    if (mapInstance.current) {
      fetchGrid(mapInstance.current, mode);
    }
  }, [mode, fetchGrid]);

  // ── City search ───────────────────────────────────────────────────
  const searchLocation = async (query) => {
    if (!query.trim()) return;
    try {
      const res = await axios.get(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(query)}.json`,
        { params: { access_token: mapboxgl.accessToken } }
      );
      const feature = res.data.features?.[0];
      if (!feature) return;

      const [lng, lat] = feature.center;
      const placeName  = feature.place_name?.split(",")[0] ?? query;

      mapInstance.current?.flyTo({ center: [lng, lat], zoom: 8, speed: 1.2, curve: 1.4 });
      lastLatRef.current = lat;
      lastLngRef.current = lng;
      fetchInsights(lat, lng, placeName, modeRef.current);
    } catch (e) {
      console.error("Search error:", e);
    }
  };

  const accent = MODE_CONFIG[mode].accent;

  const glass = {
    background:     "rgba(8, 8, 12, 0.72)",
    backdropFilter: "blur(18px)",
    borderRadius:   "14px",
    border:         "1px solid rgba(255,255,255,0.07)",
    color:          "white",
    padding:        "14px 16px",
    boxShadow:      "0 8px 32px rgba(0,0,0,0.5)",
    transition:     "opacity 0.4s ease, transform 0.4s ease",
    opacity:        loaded ? 1 : 0,
    transform:      loaded ? "translateY(0)" : "translateY(12px)",
    fontFamily:     "'Sora', sans-serif",
  };

  return (
    <div style={{ position: "relative" }}>
      <link href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;600&display=swap" rel="stylesheet" />

      <style>{`
        @keyframes pulse-ring {
          0%   { box-shadow: 0 0 0 0 rgba(239,68,68,0.6); }
          70%  { box-shadow: 0 0 0 10px rgba(239,68,68,0); }
          100% { box-shadow: 0 0 0 0 rgba(239,68,68,0); }
        }
        @keyframes pulse-dot {
          0%,100% { opacity: 1; }
          50%      { opacity: 0.4; }
        }
        @keyframes fade-in {
          from { opacity: 0; transform: translateY(-6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes grid-pulse {
          0%,100% { opacity: 1; }
          50%      { opacity: 0.3; }
        }
      `}</style>

      {/* Map */}
      <div ref={mapRef} style={{ height: "100vh", width: "100vw" }} />

      {/* Alert badge */}
      {alert && loaded && (
        <div style={{
          position: "absolute",
          top: 20,
          left: "50%",
          transform: "translateX(-50%)",
          marginTop: 64,
          background: "rgba(239,68,68,0.15)",
          border: "1px solid rgba(239,68,68,0.5)",
          borderRadius: 12,
          padding: "8px 16px",
          color: "white",
          fontFamily: "'Sora', sans-serif",
          fontSize: 13,
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          gap: 8,
          animation: "fade-in 0.3s ease, pulse-ring 1.5s ease-out infinite",
          backdropFilter: "blur(18px)",
          boxShadow: "0 4px 20px rgba(239,68,68,0.2)",
          zIndex: 10,
          whiteSpace: "nowrap",
        }}>
          <div style={{
            width: 8, height: 8,
            borderRadius: "50%",
            background: "#ef4444",
            animation: "pulse-dot 1s ease-in-out infinite",
            flexShrink: 0,
          }} />
          ⚠️ Severe conditions detected in this area
        </div>
      )}

      {/* Search */}
      <div style={{
        position: "absolute", top: 20, left: "50%",
        transform: loaded ? "translateX(-50%) translateY(0)" : "translateX(-50%) translateY(-10px)",
        opacity: loaded ? 1 : 0,
        transition: "all 0.35s ease",
        ...glass,
        padding: "10px 14px",
        display: "flex", alignItems: "center", gap: 10,
        minWidth: 280,
        zIndex: 20,
      }}>
        <span style={{ opacity: 0.4, fontSize: 14 }}>⌕</span>
        <input
          placeholder="Search a city..."
          style={{
            background: "transparent", border: "none", outline: "none",
            color: "white", fontSize: 14, flex: 1,
            fontFamily: "'Sora', sans-serif",
          }}
          onKeyDown={e => e.key === "Enter" && searchLocation(e.target.value)}
        />
      </div>

      {/* Mode toggles */}
      <div style={{
        position: "absolute", top: 20, right: 20,
        display: "flex", flexDirection: "column", gap: 6,
        ...glass,
        zIndex: 20,
      }}>
        <p style={{ margin: "0 0 6px", fontSize: 10, letterSpacing: "0.12em", opacity: 0.4, textTransform: "uppercase" }}>
          Risk mode
        </p>
        {Object.entries(MODE_CONFIG).map(([key, cfg]) => (
          <button
            key={key}
            onClick={() => setMode(key)}
            style={{
              padding: "8px 14px",
              borderRadius: 10,
              border: `1px solid ${mode === key ? accent : "rgba(255,255,255,0.07)"}`,
              background: mode === key ? `${accent}22` : "transparent",
              color: mode === key ? accent : "rgba(255,255,255,0.55)",
              cursor: "pointer",
              fontFamily: "'Sora', sans-serif",
              fontWeight: 600,
              fontSize: 12,
              letterSpacing: "0.08em",
              transition: "all 0.2s ease",
              display: "flex", gap: 7, alignItems: "center",
            }}
          >
            <span style={{ fontSize: 14 }}>{cfg.icon}</span>
            {cfg.label}
          </button>
        ))}
      </div>

      {/* Insights panel */}
      {insightTitle && (
        <div style={{
          position: "absolute", bottom: 24, left: 20,
          maxWidth: 270,
          zIndex: 20,
          ...glass,
        }}>
          <p style={{ margin: "0 0 2px", fontSize: 10, letterSpacing: "0.12em", opacity: 0.4, textTransform: "uppercase" }}>
            AI Insights
          </p>
          <p style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 600, color: accent }}>
            {insightTitle}
          </p>
          {insights.length === 0 ? (
            <p style={{ fontSize: 13, opacity: 0.5, fontStyle: "italic" }}>Analyzing...</p>
          ) : (
            insights[0]
              .split("\n")
              .map(l => l.trim())
              .filter(Boolean)
              .map((line, i, arr) => (
                <div key={i} style={{
                  display: "flex", gap: 8, alignItems: "flex-start",
                  marginBottom: 10,
                  paddingBottom: 10,
                  borderBottom: i < arr.length - 1 ? "1px solid rgba(255,255,255,0.06)" : "none",
                }}>
                  <span style={{ fontSize: 16, lineHeight: 1.4, flexShrink: 0 }}>
                    {line.slice(0, 2)}
                  </span>
                  <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, opacity: 0.85 }}>
                    {line.slice(2).trim()}
                  </p>
                </div>
              ))
          )}
        </div>
      )}

      {/* Legend */}
      <div style={{
        position: "absolute", bottom: 24, right: 20,
        zIndex: 20,
        ...glass,
        padding: "12px 16px",
      }}>
        <p style={{ margin: "0 0 8px", fontSize: 10, letterSpacing: "0.12em", opacity: 0.4, textTransform: "uppercase" }}>
          Risk level
        </p>
        {[
          { color: "#3b82f6", label: "Low" },
          { color: "#22c55e", label: "Moderate" },
          { color: "#f59e0b", label: "High" },
          { color: "#ef4444", label: "Severe" },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
            <div style={{ width: 28, height: 12, borderRadius: 3, background: color, opacity: 0.8 }} />
            <span style={{ fontSize: 12, opacity: 0.7 }}>{label}</span>
          </div>
        ))}
      </div>

      {/* Fetching indicator */}
      {fetching && (
        <div style={{
          position: "absolute", top: 20, left: 20,
          zIndex: 20,
          ...glass,
          padding: "8px 14px",
          fontSize: 12, opacity: 0.7,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <div style={{
            width: 8, height: 8, borderRadius: "50%",
            background: accent,
            animation: "grid-pulse 1s ease-in-out infinite",
          }} />
          Loading grid...
        </div>
      )}
    </div>
  );
}