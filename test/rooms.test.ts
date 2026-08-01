import { describe, expect, it } from "vitest";

import {
  extensionExpiry,
  isRoomCode,
  isRoomPurpose,
  minutesRemaining,
  normalizeRoomRules,
} from "../src/domain/rooms";

describe("room input boundary", () => {
  it("accepts exactly five ASCII digits", () => {
    expect(isRoomCode("01234")).toBe(true);
    expect(isRoomCode("1234")).toBe(false);
    expect(isRoomCode("１２３４５")).toBe(false);
  });

  it("accepts only fixed purposes and fixed rules", () => {
    expect(isRoomPurpose("event")).toBe(true);
    expect(isRoomPurpose("trade")).toBe(false);
    expect(normalizeRoomRules(["mistakes-ok", "sf-none", "mistakes-ok"])).toEqual([
      "mistakes-ok",
      "sf-none",
    ]);
    expect(normalizeRoomRules(["contact-me"])).toBeNull();
  });
});

describe("short-lived room clock", () => {
  it("shows whole minutes without going below zero", () => {
    expect(minutesRemaining(721, 1)).toBe(12);
    expect(minutesRemaining(61, 1)).toBe(1);
    expect(minutesRemaining(1, 2)).toBe(0);
  });

  it("extends by twelve minutes but never beyond thirty from creation", () => {
    expect(extensionExpiry(100, 200)).toBe(920);
    expect(extensionExpiry(100, 1_500)).toBe(1_900);
  });
});
