import { afterEach, describe, expect, it, vi } from "vitest";
import { contentDisposition, fileResponse, rateLimiter } from "@/lib/files/http";
import { expiryText, renderSharePage } from "@/lib/files/share-page";
import { checkSharePassword, createShare, getShare, listShares, recordDownload, revokeShare, shareState, toShareInfo, TOKEN } from "@/lib/files/shares";
import { fileKind } from "@/lib/files/types";
import { eta, fingerprint } from "@/lib/files/upload-engine";
import { createUpload, getUpload, pruneUploads, UPLOAD_TTL_MS } from "@/lib/files/uploads";
import { UPLOAD_ID } from "@/lib/homeserver/nextcloud";
import { memoryDb } from "./support/db";

const DAY = 86_400_000;
const base = { path: "/02 Musik/Beat.wav", fileId: 7, name: "Beat.wav", size: 1234, contentType: "audio/wav" };

describe("Freigabe-Links", () => {
  it("legt Links mit zufälligem Token und Ablauf an", () => {
    const db = memoryDb();
    const now = Date.UTC(2026, 9, 23);
    const a = createShare(db, { ...base, expiry: "7d" }, now);
    const b = createShare(db, { ...base, expiry: "never" }, now);
    expect(a.token).toMatch(TOKEN);
    expect(a.token).not.toBe(b.token);
    expect(a.expires_at).toBe(now + 7 * DAY);
    expect(b.expires_at).toBeNull();
    expect(getShare(db, a.token)).toMatchObject({ path: base.path, downloads: 0, password_hash: null });
    expect(getShare(db, "../../etc")).toBeNull();
  });

  it("unterscheidet aktiv, abgelaufen und widerrufen", () => {
    const db = memoryDb();
    const now = Date.UTC(2026, 9, 23);
    const s = createShare(db, { ...base, expiry: "1d" }, now);
    expect(shareState(s, now)).toBe("aktiv");
    expect(shareState(s, now + DAY)).toBe("abgelaufen");
    expect(revokeShare(db, s.token, now)).toBe(true);
    expect(revokeShare(db, s.token, now)).toBe(false);
    expect(shareState(getShare(db, s.token)!, now)).toBe("widerrufen");
  });

  it("speichert Passwörter nur als Hash und prüft sie", () => {
    const db = memoryDb();
    const s = createShare(db, { ...base, expiry: "7d", password: "geheim 123" });
    expect(s.password_hash).toMatch(/^scrypt\$/);
    expect(s.password_hash).not.toContain("geheim");
    expect(checkSharePassword(s, "geheim 123")).toBe(true);
    expect(checkSharePassword(s, "geheim")).toBe(false);
    expect(checkSharePassword({ password_hash: null }, "")).toBe(true);
  });

  it("zählt Downloads und listet aktive zuerst", () => {
    const db = memoryDb();
    const now = Date.now();
    const old = createShare(db, { ...base, expiry: "1d" }, now - 2 * DAY);
    const fresh = createShare(db, { ...base, expiry: "7d" }, now - 1000);
    recordDownload(db, fresh.token, now);
    recordDownload(db, fresh.token, now);
    const rows = listShares(db, now);
    expect(rows.map((r) => r.token)).toEqual([fresh.token, old.token]);
    const info = toShareInfo(rows[0], "https://host.ts.net:10000/", now);
    expect(info).toMatchObject({ downloads: 2, state: "aktiv", hasPassword: false, url: `https://host.ts.net:10000/d/${fresh.token}` });
    expect(info).not.toHaveProperty("password_hash");
  });
});

describe("Upload-Sitzungen", () => {
  it("erzeugt IDs, die der Nextcloud-Client akzeptiert, und räumt alte weg", () => {
    const db = memoryDb();
    const now = Date.now();
    const u = createUpload(db, "/00 Eingang/film.mp4", 5, now);
    expect(u.id).toMatch(UPLOAD_ID);
    expect(getUpload(db, u.id, now)).toMatchObject({ path: "/00 Eingang/film.mp4", size: 5 });
    expect(getUpload(db, u.id, now + UPLOAD_TTL_MS + 1)).toBeNull();
    expect(pruneUploads(db, now + UPLOAD_TTL_MS + 1)).toBe(1);
  });
});

describe("Download-Seite", () => {
  const token = "x".repeat(43);

  it("maskiert Dateinamen und lädt nichts von außerhalb", () => {
    const html = renderSharePage({
      kind: "file",
      token,
      name: `<script>alert(1)</script>.pdf`,
      size: 2048,
      contentType: "application/pdf",
      expiresAt: null,
      downloads: 0,
      preview: false,
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain(`href="/d/${token}/download"`);
    expect(html).not.toMatch(/<script|src="http|_next/);
    expect(html).toContain("läuft nicht ab");
  });

  it("zeigt bei Passwortschutz nur das Formular", () => {
    const html = renderSharePage({ kind: "password", token, name: "a.zip", wrong: true });
    expect(html).toContain(`action="/d/${token}"`);
    expect(html).toContain("Falsches Passwort");
    expect(html).not.toContain("/download");
  });

  it("beschreibt den Ablauf verständlich", () => {
    const now = 0;
    expect(expiryText(30 * 60_000, now)).toBe("läuft in weniger als einer Stunde ab");
    expect(expiryText(5 * 3_600_000, now)).toBe("läuft in 5 Stunden ab");
    expect(expiryText(DAY + 1, now)).toBe("läuft in 1 Tag ab");
    expect(expiryText(7 * DAY, now)).toBe("läuft in 7 Tagen ab");
  });
});

describe("Datei-Antworten", () => {
  it("liefert HTML und SVG nie inline aus", () => {
    for (const type of ["text/html", "image/svg+xml", "application/pdf"]) {
      const res = fileResponse(new Response("x", { headers: { "content-type": type } }), "a", { inline: true });
      expect(res.headers.get("content-type")).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    }
    const img = fileResponse(new Response("x", { headers: { "content-type": "image/jpeg", "content-length": "1" } }), "a.jpg", { inline: true });
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect(img.headers.get("content-disposition")).toMatch(/^inline/);
    expect(img.headers.get("content-security-policy")).toContain("sandbox");
    expect(img.headers.get("content-length")).toBe("1");
  });

  it("kodiert Umlaute im Dateinamen", () => {
    expect(contentDisposition("attachment", 'Übung "4".pdf')).toBe(`attachment; filename="_bung _4_.pdf"; filename*=UTF-8''%C3%9Cbung%20%224%22.pdf`);
  });

  it("begrenzt Anfragen je Schlüssel und Fenster", () => {
    const allow = rateLimiter(2, 1000);
    expect([allow("ip", 0), allow("ip", 1), allow("ip", 2), allow("andere", 2), allow("ip", 1001)]).toEqual([true, true, false, true, true]);
  });
});

describe("Upload im Browser", () => {
  afterEach(() => vi.useRealTimers());

  it("erkennt dieselbe Datei am selben Ziel wieder", () => {
    const f = { name: "a.wav", size: 10, lastModified: 5 };
    expect(fingerprint(f, "/x", "")).toBe(fingerprint({ ...f }, "/x", ""));
    expect(fingerprint(f, "/x", "")).not.toBe(fingerprint(f, "/y", ""));
  });

  it("rechnet die Restzeit", () => {
    expect(eta({ size: 100, loaded: 50, speed: 0 })).toBeNull();
    expect(eta({ size: 100, loaded: 50, speed: 10 })).toBe("noch 5 s");
    expect(eta({ size: 10_000, loaded: 0, speed: 10 })).toBe("noch 17 min");
  });

  it("ordnet Dateiarten zu", () => {
    expect(fileKind({ name: "Beat 12.flp", isDir: false, contentType: "application/octet-stream" })).toBe("project");
    expect(fileKind({ name: "x", isDir: false, contentType: "video/mp4" })).toBe("video");
    expect(fileKind({ name: "Ordner", isDir: true, contentType: null })).toBe("folder");
  });
});
