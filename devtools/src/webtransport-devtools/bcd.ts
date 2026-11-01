// MDN Browser Compat Data (BCD) に基づく WebTransport API のブラウザ対応状況の静的テーブル
//
// 出典: MDN Browser Compat Data
//   https://github.com/mdn/browser-compat-data
// 確認日: 2026-10-31
//
// 本テーブルは W3C WebTransport Candidate Recommendation (2026-07-30) の
// 設定項目（§5.3 / §6.9 / §6.11）のブラウザ対応状況を UI に表示するためのもの。
// BCD にエントリが無い項目（headers / datagramsReadableType / waitUntilAvailable）は
// 本テーブルに含めない。protocols は BCD にエントリが追加済み (2026-08-28) のため含める。
// 既存の StaticApiSupportPanel はプロトタイプレベルの実行時検出であり、
// 本テーブルとは役割が異なる。

// ブラウザごとの対応状況
// - バージョン文字列: そのバージョン以降で対応している
// - null: 対応していない
// - "preview": プレビュー版 (Safari Technology Preview など) でのみ対応している
export type BcdBrowserSupport = string | null;

export interface BcdSupportEntry {
  // 設定項目の表示名 (BcdBadges の name プロパティと対応する)
  name: string;
  // W3C WebTransport 仕様の節番号
  section: string;
  // 各ブラウザの対応状況
  chrome: BcdBrowserSupport;
  firefox: BcdBrowserSupport;
  safari: BcdBrowserSupport;
  // BCD の status.experimental。true の項目だけに指定する
  experimental?: boolean;
  // 補足説明。BcdBadges は指定された場合だけ title 属性に表示する
  notes?: string;
}

// 出典と確認日の表示用テキスト
export const BCD_SOURCE = "MDN Browser Compat Data";
export const BCD_SOURCE_URL = "https://github.com/mdn/browser-compat-data";
export const BCD_CONFIRMED_DATE = "2026-10-31";

const bcdEntryList = [
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
    // BCD の feature は WebTransportOptions.protocols (コンストラクタの options)。
    // サーバーとの application-level protocol のネゴシエーションに使う
    name: "protocols",
    section: "§6.9",
    chrome: "143",
    firefox: "155",
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
    // BCD の feature は WebTransport の属性
    // (api.WebTransport.anticipatedConcurrentIncomingUnidirectionalStreams) であり、
    // WebTransportOptions の設定項目そのものではない。値はコンストラクタの options で
    // 指定するため、設定項目の対応状況として扱う (§6.9)
    name: "anticipatedConcurrentIncomingUnidirectionalStreams",
    section: "§6.9",
    chrome: null,
    firefox: null,
    safari: "26.4",
    experimental: true,
  },
  {
    // BCD の feature は WebTransport の属性
    // (api.WebTransport.anticipatedConcurrentIncomingBidirectionalStreams) であり、
    // WebTransportOptions の設定項目そのものではない。値はコンストラクタの options で
    // 指定するため、設定項目の対応状況として扱う (§6.9)
    name: "anticipatedConcurrentIncomingBidirectionalStreams",
    section: "§6.9",
    chrome: null,
    firefox: null,
    safari: "26.4",
    experimental: true,
  },
  {
    // BCD の feature は createBidirectionalStream / createUnidirectionalStream の
    // options.sendOrder。WebTransportSendStream.sendOrder (Firefox 121) と
    // WebTransportDatagramsWritable.sendOrder (Firefox 155) は BCD の別 feature
    name: "sendOrder",
    section: "§6.11",
    chrome: null,
    firefox: "119",
    safari: "26.4",
    notes:
      "BCD feature is create*Stream options.sendOrder (WebTransportSendStream.sendOrder: Firefox 121, WebTransportDatagramsWritable.sendOrder: Firefox 155)",
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
    // BCD の feature は WebTransportDatagramDuplexStream の属性で experimental。
    // Safari は Technology Preview でのみ対応している
    name: "incomingMaxBufferedDatagrams",
    section: "§5.3",
    chrome: "151",
    firefox: null,
    safari: "preview",
    experimental: true,
  },
  {
    // BCD の feature は WebTransportDatagramDuplexStream の属性で experimental。
    // Safari は Technology Preview でのみ対応している
    name: "outgoingMaxBufferedDatagrams",
    section: "§5.3",
    chrome: "151",
    firefox: null,
    safari: "preview",
    experimental: true,
  },
] as const satisfies readonly BcdSupportEntry[];

// 表示に使うテーブル。要素の型を BcdSupportEntry にして optional な
// experimental / notes を参照できるようにする
export const bcdSupportEntries: readonly BcdSupportEntry[] = bcdEntryList;

// BcdBadges の name プロパティで指定できる項目名
// テーブルに無い名前を渡すと型エラーになるため、タイポをビルド時に検出できる
export type BcdSupportName = (typeof bcdEntryList)[number]["name"];
