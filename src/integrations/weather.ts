import "server-only";
import { addDays, today } from "@/lib/time";
import { env } from "@/lib/env";
import { fetchJson, type Integration } from "./core";

export type Coords = { lat: number; lon: number };

export type Weather = {
  place: string | null;
  current: { temp: number; feelsLike: number; code: number; wind: number; isDay: boolean };
  hourly: { time: string; temp: number; precipProb: number; code: number }[];
  daily: { day: string; code: number; max: number; min: number; precipProb: number }[];
  sunrise: string;
  sunset: string;
};

type OpenMeteo = {
  current: { temperature_2m: number; apparent_temperature: number; weather_code: number; wind_speed_10m: number; is_day: number };
  hourly: { time: string[]; temperature_2m: number[]; precipitation_probability: number[]; weather_code: number[] };
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: number[];
    sunrise: string[];
    sunset: string[];
  };
};

/** Koordinaten auf ~1 km runden: bessere Cache-Trefferquote und kein exakter Standort in Logs/Cache. */
export function roundCoords({ lat, lon }: Coords): Coords {
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
}

export function mapOpenMeteo(raw: OpenMeteo, place: string | null, nowIso: string): Weather {
  const startIdx = Math.max(0, raw.hourly.time.findIndex((t) => t >= nowIso.slice(0, 13)));
  return {
    place,
    current: {
      temp: raw.current.temperature_2m,
      feelsLike: raw.current.apparent_temperature,
      code: raw.current.weather_code,
      wind: raw.current.wind_speed_10m,
      isDay: raw.current.is_day === 1,
    },
    hourly: raw.hourly.time.slice(startIdx, startIdx + 12).map((time, i) => ({
      time,
      temp: raw.hourly.temperature_2m[startIdx + i],
      precipProb: raw.hourly.precipitation_probability[startIdx + i] ?? 0,
      code: raw.hourly.weather_code[startIdx + i],
    })),
    daily: raw.daily.time.map((day, i) => ({
      day,
      code: raw.daily.weather_code[i],
      max: raw.daily.temperature_2m_max[i],
      min: raw.daily.temperature_2m_min[i],
      precipProb: raw.daily.precipitation_probability_max[i] ?? 0,
    })),
    sunrise: raw.daily.sunrise[0],
    sunset: raw.daily.sunset[0],
  };
}

async function placeName({ lat, lon }: Coords): Promise<string | null> {
  try {
    const res = await fetchJson<{ address?: Record<string, string> }>(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=de&lat=${lat}&lon=${lon}`,
      { headers: { "User-Agent": "LifeOS dashboard (github.com/ZitrusmitZ/lifeos)" } },
      5000,
    );
    const a = res.address ?? {};
    return a.city ?? a.town ?? a.village ?? a.municipality ?? a.county ?? null;
  } catch {
    return null;
  }
}

export const weather: Integration<Weather, Coords> = {
  id: "weather",
  ttlSeconds: 15 * 60,
  missingConfig: () => null,
  cacheKey: (c) => {
    const r = roundCoords(c);
    return `${r.lat},${r.lon}`;
  },
  async fetch(coords) {
    const { lat, lon } = roundCoords(coords);
    const params = new URLSearchParams({
      latitude: String(lat),
      longitude: String(lon),
      current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day",
      hourly: "temperature_2m,precipitation_probability,weather_code",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
      timezone: env().APP_TZ,
      forecast_days: "5",
    });
    const [raw, place] = await Promise.all([
      fetchJson<OpenMeteo>(`https://api.open-meteo.com/v1/forecast?${params}`),
      placeName({ lat, lon }),
    ]);
    const nowLocal = new Intl.DateTimeFormat("sv-SE", {
      timeZone: env().APP_TZ,
      dateStyle: "short",
      timeStyle: "short",
    })
      .format(new Date())
      .replace(" ", "T");
    return mapOpenMeteo(raw, place, nowLocal);
  },
  mock() {
    const d = today();
    const hours = Array.from({ length: 12 }, (_, i) => {
      const h = (14 + i) % 24;
      return {
        time: `${h < 14 ? addDays(d, 1) : d}T${String(h).padStart(2, "0")}:00`,
        temp: Math.round((17 - Math.abs(i - 2) * 0.9) * 10) / 10,
        precipProb: [5, 5, 10, 20, 35, 40, 25, 10, 5, 5, 0, 0][i],
        code: [1, 2, 2, 3, 61, 61, 3, 2, 1, 0, 0, 0][i],
      };
    });
    return {
      place: "Berlin",
      current: { temp: 16.4, feelsLike: 15.1, code: 2, wind: 12, isDay: true },
      hourly: hours,
      daily: [
        { day: d, code: 61, max: 17, min: 9, precipProb: 40 },
        { day: addDays(d, 1), code: 3, max: 15, min: 8, precipProb: 20 },
        { day: addDays(d, 2), code: 1, max: 18, min: 7, precipProb: 5 },
        { day: addDays(d, 3), code: 63, max: 13, min: 9, precipProb: 80 },
        { day: addDays(d, 4), code: 2, max: 14, min: 6, precipProb: 15 },
      ],
      sunrise: `${d}T07:21`,
      sunset: `${d}T18:31`,
    };
  },
};
