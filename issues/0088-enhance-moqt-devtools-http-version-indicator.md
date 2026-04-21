# moqt-devtools に HTTP/2 / HTTP/3 の接続判別表示を追加する

Created: 2026-04-22
Model: Opus 4.7

## 概要

moqt-devtools に、現在の WebTransport セッションが HTTP/2 / HTTP/3 どちらで確立されたかを可視化する仕組みを追加する。判別は `WebTransport.reliability` プロパティの値から行う。Connection Settings 周辺に「HTTP Version: h3」といった表示を追加する。

## 根拠

### reliability からの判別が可能

W3C WebTransport 仕様 ( https://www.w3.org/TR/webtransport/#dom-webtransport-reliability ) の `reliability` enum は以下の値を取る。

- `"pending"` — セッション未確立
- `"reliable-only"` — 信頼性のみ対応 (datagram 不可)
- `"supports-unreliable"` — 信頼性と非信頼性の両方に対応 (datagram 可)

draft-ietf-webtrans-http2 ( https://datatracker.ietf.org/doc/draft-ietf-webtrans-http2/ ) は TCP ベースで datagram をサポートしない。一方 draft-ietf-webtrans-http3 ( https://datatracker.ietf.org/doc/draft-ietf-webtrans-http3/ ) は QUIC DATAGRAM frame による datagram をサポートする。

このため `reliability` の値は実質「どちらの WebTransport ドラフトで接続しているか」の指標となる。

| reliability 値         | WebTransport ドラフト          | 表示   |
| ---------------------- | ------------------------------ | ------ |
| `"reliable-only"`      | draft-ietf-webtrans-http2      | HTTP/2 |
| `"supports-unreliable"` | draft-ietf-webtrans-http3      | HTTP/3 |
| `"pending"`            | 未確立                         | --     |

### MOQT DevTools で HTTP バージョンを見えるようにしたい動機

- MOQT の動作確認時に、クライアント/サーバーがどの WebTransport ドラフトで接続したかを可視化したい。
- サーバー側のアップグレード試験 (H2 クライアント実装 vs H3 クライアント実装) の結果を一目で確認できる。
- datagram 経路 (SUBGROUP の unreliable transmission) が使える/使えないの区別が UI 上で判断しやすくなる。

## 該当箇所

- `src/session/session.ts`
  - `Session` に `reliability` ゲッターを追加し、内部の `transport.reliability` を公開する
- `src/index.ts`
  - (必要なら) `connect()` の返り値に関する補足は不要。`Session.reliability` 経由で十分
- `devtools/src/signals/connectionSettings.ts`
  - `httpVersion` 派生 signal を追加 (reliability 値から "HTTP/3" / "HTTP/2" / "--" に変換)
- `devtools/src/hooks/usePublisher.ts` または共通 hook
  - 接続成功時に `session.reliability` を読み取り signal に反映する
- `devtools/src/components/ConnectionSettings.tsx` または接続ステータス表示箇所
  - `HTTP Version: HTTP/3` 形式のバッジを追加する (H3=緑、H2=青、--=灰)
- `devtools/src/webtransport-devtools/signals.ts`
  - `wtHttpVersion` computed signal を追加 (wt-devtools 側にも同様の表示を入れる)
- `devtools/src/webtransport-devtools/components/ConnectionPanel.tsx`
  - 接続後ブロックに HTTP Version 表示を追加する

## 修正方針

### 判別ロジック

純粋関数として `toHttpVersionLabel(reliability: string | undefined): "HTTP/2" | "HTTP/3" | "--"` を定義する。

```ts
function toHttpVersionLabel(reliability: string | undefined): "HTTP/2" | "HTTP/3" | "--" {
  if (reliability === "supports-unreliable") return "HTTP/3";
  if (reliability === "reliable-only") return "HTTP/2";
  return "--";
}
```

wt-devtools と moqt-devtools の両方からこの関数を利用する。

### 表示形式

- バッジ形式 (丸い角の tag)
- 色分け: H3=緑、H2=青、未確立=灰
- 既存の `reliability` 文字列表示は残し、その上または隣に HTTP Version バッジを置く (判定根拠が見える)

### ライブラリ側の公開 API

`Session` に `get reliability(): string` を追加する。これは WebTransport の `reliability` プロパティをそのまま返す。

```ts
public get reliability(): string {
  return this.transport.reliability;
}
```

`close` 済みでも参照されうるため、`transport` が null になる前にキャッシュするか、もしくは接続中のみ有効と明記する。

## 検証

- `vp run build` が通ること
- `vp run build:devtools` が通ること
- `vitest run` で既存テストが通ること
- `toHttpVersionLabel` の単体テスト (3 つの入力) を追加して通ること
- Chrome の WebTransport (HTTP/3) で接続すると `HTTP/3` 表示になること
- HTTP/2 版 WebTransport 実装のサーバーに接続した際に `HTTP/2` 表示になること (対応サーバーがあれば)
- `reliability === "pending"` の状態で `--` 表示になること
