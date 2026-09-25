/**
 * 確立した WebTransport を画面の H2 / H3 にする。
 *
 * W3C WebTransport の reliability
 * https://www.w3.org/TR/webtransport/#dom-webtransport-reliability
 * (値の意味は仕様が変わる可能性がある)
 * - "supports-unreliable" は HTTP/3 (draft-ietf-webtrans-http3、datagram 可)
 * - "reliable-only" は HTTP/2 (draft-ietf-webtrans-http2、datagram 不可)
 * - "pending" は未確立なので出さない
 *
 * 安定版の Chromium は reliability を出さない
 * (RuntimeEnabled=WebTransportReliability が experimental)。
 * Chromium は HTTP/3 の WebTransport しか確立しないため、属性が無く
 * chromium が true のときは H3 にする。属性が読めたときはその値を優先する。
 * Chromium が HTTP/2 を実装したまま reliability を出さないと、ここは H3 と誤る。
 */
export type PanelHttpVersion = "H2" | "H3";

export function resolvePanelHttpVersion(
  reliability: string | undefined,
  chromium: boolean,
): PanelHttpVersion | null {
  if (reliability === "supports-unreliable") return "H3";
  if (reliability === "reliable-only") return "H2";
  if (reliability !== undefined) return null;
  if (chromium) return "H3";
  return null;
}

/**
 * UA-CH の brands。TypeScript の DOM lib に navigator.userAgentData が無いため、
 * ここだけで読む。
 */
export interface UserAgentDataBrands {
  brands?: ReadonlyArray<{ brand: string; version: string }>;
}

export function isChromium(userAgentData: UserAgentDataBrands | undefined): boolean {
  const brands = userAgentData?.brands;
  if (brands === undefined) return false;
  return brands.some((entry) => entry.brand === "Chromium");
}

export function browserIsChromium(): boolean {
  const nav = navigator as Navigator & { userAgentData?: UserAgentDataBrands };
  return isChromium(nav.userAgentData);
}
