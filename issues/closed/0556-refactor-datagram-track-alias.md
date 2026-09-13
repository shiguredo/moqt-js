# decodeDatagramTrackAlias のワイヤ配置知識の重複を解消する

- Created: 2026-09-09
- Completed: 2026-09-13
- Branch: feature/refactor-datagram-track-alias
- Polished: YYYY-MM-DD

## 目的

`src/session/incoming.ts` の `decodeDatagramTrackAlias` が `decodeObjectDatagram` の先頭 2 varint 配置（Type Flags → Track Alias）を再実装している。配置変更時に両方を直す必要があり、失敗時に誤った alias を引いて無関係な購読を cancel し得る。

## 現状

- `decodeObjectDatagram` は Type Flags → Track Alias の順でデコードする。
- `decodeDatagramTrackAlias` はデコード失敗時に同じ配置を再解析して alias を取り出す。

## 設計方針

1. `decodeObjectDatagram` の例外に trackAlias を持たせる、または先頭解析を共有ヘルパー化して 1 箇所に寄せる。
2. 挙動は変えない。

## 完了条件

- ワイヤ配置知識が 1 箇所になること。
- 既存テストが通ること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 関連

- draft-ietf-moq-transport-20 §11.3.1
- `decodeObjectDatagram` / `decodeDatagramTrackAlias`

## 解決方法

設計方針 1 の「先頭解析を共有ヘルパー化して 1 箇所に寄せる」を採用した。

- `src/dataStream.ts` に `decodeDatagramTypeAndTrackAlias(data, offset)` を追加した。Type Flags の読み取りと検証 (0b00X0XXXX 形式・STATUS と END_OF_GROUP の同時設定) および Track Alias の読み取りを行い、`{ type, trackAlias, consumed }` を返す。
- `decodeObjectDatagram` はこのヘルパーを呼んでから Group ID 以降を読む形に変更した。検証の順序と例外は従来どおり (ヘルパー内で同じメッセージの `ProtocolViolationError` を throw する)。
- `src/session/incoming.ts` の `decodeDatagramTrackAlias` は自前の再解析をやめ、同ヘルパーの `trackAlias` を返す形にした。例外時は従来どおり `undefined` を返す。
- 挙動は変えていない。`decodeDatagramTrackAlias` は不正な Type Flags でも例外を握り潰すため、cancel 対象の解決結果は従来と同じになる。
- ワイヤ配置知識と検証が 1 箇所になり、片方だけが配置を変わる事故を防げる。
- テスト: `src/dataStream.datagram.test.ts` に 2 件追加した。共通ヘルパーが `type` と `trackAlias` を返し Type Flags と Track Alias の 2 バイトだけを消費すること、不正な Type Flags で `ProtocolViolationError` を throw することを検証する (この 2 分岐は従来テストが無かった)。
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した。

## 検証

- `pnpm test run`: 70 ファイル / 2,093 テスト全通過 (追加した 2 件を含む)
- `pnpm typecheck` / `pnpm lint` / `pnpm fmt` すべて成功
