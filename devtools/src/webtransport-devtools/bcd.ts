// MDN Browser Compat Data (BCD) に基づく WebTransport API のブラウザ対応状況の静的テーブル
//
// 出典: MDN Browser Compat Data
//   https://github.com/mdn/browser-compat-data
// 確認日: 2026-08-05
//
// 本テーブルは W3C WebTransport Candidate Recommendation (2026-07-30) の
// 設定項目（§5.3 / §6.9 / §6.11）のブラウザ対応状況を UI に表示するためのもの。
// BCD にエントリが無い項目（headers / protocols / datagramsReadableType /
// waitUntilAvailable など）は本テーブルに含めない。
// 既存の StaticApiSupportPanel（detectStaticApiSupport）はプロトタイプレベルの
// 実行時検出であり、本テーブルとは役割が異なる。

export interface BcdSupportEntry {
  // 設定項目の表示名
  name: string;
  // W3C WebTransport 仕様の節番号
  section: string;
  // 各ブラウザの対応開始バージョン。未対応は null
  chrome: string | null;
  firefox: string | null;
  safari: string | null;
}

// 出典と確認日の表示用テキスト
export const BCD_SOURCE = "MDN Browser Compat Data";
export const BCD_SOURCE_URL = "https://github.com/mdn/browser-compat-data";
export const BCD_CONFIRMED_DATE = "2026-08-05";

export const bcdSupportEntries: BcdSupportEntry[] = [
  {
    name: "allowPooling",
    section: "§6.9",
    chrome: null,
    firefox: "114",
    safari: "26.4",
  },
  {
    name: "requireUnreliable",
    section: "§6.9",
    chrome: null,
    firefox: "114",
    safari: "26.4",
  },
  {
    name: "congestionControl",
    section: "§6.9",
    chrome: null,
    firefox: "114",
    safari: "26.4",
  },
  {
    name: "serverCertificateHashes",
    section: "§6.9",
    chrome: "100",
    firefox: "125",
    safari: "26.4",
  },
  {
    name: "anticipatedConcurrentIncomingUnidirectionalStreams",
    section: "§6.9",
    chrome: null,
    firefox: null,
    safari: "26.4",
  },
  {
    name: "anticipatedConcurrentIncomingBidirectionalStreams",
    section: "§6.9",
    chrome: null,
    firefox: null,
    safari: "26.4",
  },
  {
    name: "sendOrder",
    section: "§6.11",
    chrome: null,
    firefox: "119",
    safari: "26.4",
  },
  {
    name: "incomingMaxAge",
    section: "§5.3",
    chrome: "97",
    firefox: "114",
    safari: "26.4",
  },
  {
    name: "outgoingMaxAge",
    section: "§5.3",
    chrome: "97",
    firefox: "114",
    safari: "26.4",
  },
  {
    name: "incomingMaxBufferedDatagrams",
    section: "§5.3",
    chrome: "151",
    firefox: null,
    safari: null,
  },
  {
    name: "outgoingMaxBufferedDatagrams",
    section: "§5.3",
    chrome: "151",
    firefox: null,
    safari: null,
  },
];
