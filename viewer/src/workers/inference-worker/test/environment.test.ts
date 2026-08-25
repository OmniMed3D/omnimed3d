import { describe, expect, it } from "vitest";
import { isWebKitForced } from "../src/environment.js";

const IPHONE_SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0.6422.80 Mobile/15E148 Safari/604.1";
const IPAD_SAFARI =
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
// iPadOS 13+ default UA masquerades as a desktop Mac (no "iPad" substring)
// -- indistinguishable from real desktop Safari at the UA level, see
// environment.ts's header comment for why that's fine here.
const IPAD_MASQUERADING_AS_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const MACOS_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const MACOS_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const MACOS_FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:126.0) Gecko/20100101 Firefox/126.0";
const WINDOWS_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36";

describe("isWebKitForced", () => {
  it("is true for any iOS browser, not just Safari (Apple mandates WebKit under the hood)", () => {
    expect(isWebKitForced(IPHONE_SAFARI)).toBe(true);
    expect(isWebKitForced(IPHONE_CHROME)).toBe(true);
    expect(isWebKitForced(IPAD_SAFARI)).toBe(true);
  });

  it("is true for an iPad masquerading as a desktop Mac (indistinguishable from real desktop Safari)", () => {
    expect(isWebKitForced(IPAD_MASQUERADING_AS_MAC)).toBe(true);
  });

  it("is true for real desktop macOS Safari", () => {
    expect(isWebKitForced(MACOS_SAFARI)).toBe(true);
  });

  it("is false for non-Safari desktop macOS browsers (Blink/Gecko, not WebKit)", () => {
    expect(isWebKitForced(MACOS_CHROME)).toBe(false);
    expect(isWebKitForced(MACOS_FIREFOX)).toBe(false);
  });

  it("is false for non-Apple platforms", () => {
    expect(isWebKitForced(WINDOWS_CHROME)).toBe(false);
    expect(isWebKitForced(ANDROID_CHROME)).toBe(false);
  });
});
