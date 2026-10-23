import { describe, expect, it } from "vitest";
import { draftKey, isNearBottom, shouldSendOnEnter, splitLinks } from "@/lib/agent-input";

const key = (over: Partial<{ key: string; shiftKey: boolean; isComposing: boolean }> = {}) => ({ key: "Enter", shiftKey: false, isComposing: false, ...over });

describe("shouldSendOnEnter", () => {
  it("Desktop: Enter sendet", () => expect(shouldSendOnEnter(key(), true)).toBe(true));
  it("Desktop: Shift+Enter bricht um", () => expect(shouldSendOnEnter(key({ shiftKey: true }), true)).toBe(false));
  it("Touch: Return ist Zeilenumbruch", () => expect(shouldSendOnEnter(key(), false)).toBe(false));
  it("IME-Bestätigung sendet nicht", () => expect(shouldSendOnEnter(key({ isComposing: true }), true)).toBe(false));
  it("andere Tasten senden nicht", () => expect(shouldSendOnEnter(key({ key: "a" }), true)).toBe(false));
});

describe("isNearBottom", () => {
  it("am Ende", () => expect(isNearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true));
  it("innerhalb der Schwelle", () => expect(isNearBottom({ scrollHeight: 1000, scrollTop: 530, clientHeight: 400 })).toBe(true));
  it("weiter oben", () => expect(isNearBottom({ scrollHeight: 1000, scrollTop: 400, clientHeight: 400 })).toBe(false));
});

describe("splitLinks", () => {
  it("Text ohne Link", () => expect(splitLinks("hallo")).toEqual([{ type: "text", text: "hallo" }]));
  it("Link mitten im Text, Satzzeichen bleibt draußen", () =>
    expect(splitLinks("siehe https://example.org/a?b=1. Danke")).toEqual([
      { type: "text", text: "siehe " },
      { type: "link", text: "https://example.org/a?b=1", href: "https://example.org/a?b=1" },
      { type: "text", text: ". Danke" },
    ]));
  it("Klammer um Link", () =>
    expect(splitLinks("(https://example.org)")).toEqual([
      { type: "text", text: "(" },
      { type: "link", text: "https://example.org", href: "https://example.org" },
      { type: "text", text: ")" },
    ]));
  it("Klammer in der URL bleibt", () =>
    expect(splitLinks("https://de.wikipedia.org/wiki/A_(B)")[0]).toEqual({ type: "link", text: "https://de.wikipedia.org/wiki/A_(B)", href: "https://de.wikipedia.org/wiki/A_(B)" }));
  it("javascript: wird nie zum Link", () => expect(splitLinks("javascript:alert(1)")).toEqual([{ type: "text", text: "javascript:alert(1)" }]));
});

describe("draftKey", () => {
  it("pro Unterhaltung", () => expect(draftKey(3)).not.toBe(draftKey(4)));
});
