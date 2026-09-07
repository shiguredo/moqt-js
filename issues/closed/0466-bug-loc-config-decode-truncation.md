# LOC 単体 Config デコーダの切り詰め検出漏れ

- Created: 2026-09-06
- Completed: 2026-09-07
- Branch: feature/fix-loc-config-decode-truncation
- Polished: 2026-09-06

## 目的

`src/loc.ts` の単体デコーダ `decodeVideoConfig` と `decodeAudioConfig` が、Length 宣言に対して Value バイトが不足している切り詰めワイヤをエラーにせず、不足分の短い配列を正常値として返す。これを放置すると、不完全な Video Config / Audio Config がデコーダ設定にそのまま流れ、原因特定が困難な復号失敗になる。同一モジュールの `decodeVideoFrameMarking` が切り詰めで `ProtocolViolationError` を送出する方針と不整合であり、単体デコーダ間のエラー方針を統一するために修正が必要である。

## 現状

- `src/loc.ts` の `decodeVideoConfig` 関数は、ID と Length を `decodeVarint` で読み、`data.subarray` で Value を切り出すだけであり、残りバイトが Length に満たない場合の検査がない。`decodeAudioConfig` 関数も同形である。
- 再現手順として、`VIDEO_CONFIG` の ID バイトの後に Length 5 を宣言しながら Value を 2 バイトしか載せないワイヤを `decodeVideoConfig` に渡すと、例外なく 2 バイトの配列が返る。`AUDIO_CONFIG` でも `decodeAudioConfig` で同様である。実行確認済みである。
- 対照的に、`src/loc.ts` の `decodeVideoFrameMarkingAfterId` 関数は、宣言 Length に対する Value 不足を `ProtocolViolationError` で送出する。単体デコーダ間で切り詰めの扱いが割れている。
- 複数 Property 経路の `decodeVideoProperties` 関数と `decodeAudioProperties` 関数は、`decodeObjectPropertiesTolerant` による寛容デコードのため本件の影響を受けない。不正な Length は抽出スキップとして扱われる。影響範囲は単体デコーダの直接利用に限定される。
- 仕様根拠は `refs/moq/draft-ietf-moq-loc-04.txt` の Video Config 節と Audio Config 節であり、いずれも奇数 ID のため length + bytes 形式である。Length 宣言に満たない Value は不正ワイヤであり、正常値として扱ってはならない。

## 設計方針

1. `decodeVideoConfig` と `decodeAudioConfig` で、ID と Length の消費後に残りバイトが Length に満たない場合は `ProtocolViolationError` を送出する。メッセージは英語で具体的な不足内容を含め、既存の `decodeVideoFrameMarkingAfterId` の形式に合わせる。
2. 空 description の正常系は維持する。Length 0 で Value 0 バイトは正常として空配列を返す。
3. 単体テストとして、`src/loc.test.ts` に切り詰め入力で `ProtocolViolationError` を送出することの検証を追加する。PBT で実現できない境界値のため単体テストが妥当である。

## 完了条件

- Length 宣言に満たない Value のワイヤを `decodeVideoConfig` と `decodeAudioConfig` に渡すと `ProtocolViolationError` が送出されること
- 空 description のラウンドトリップが引き続き成立すること
- `vp test run` が pass すること

## 関連

- `refs/moq/draft-ietf-moq-loc-04.txt` の Video Config 節と Audio Config 節
- `src/loc.ts` の `decodeVideoFrameMarkingAfterId` 関数の切り詰め検査
- `src/loc.test.ts` の VideoConfig / AudioConfig に関する既存テスト

## 解決方法

- `src/loc.ts` の `decodeVideoConfig` と `decodeAudioConfig` に残量検査を追加し、Length 宣言に満たない Value は `ProtocolViolationError` で拒否する。ID / Length の varint 不完全は従来どおり `IncompleteDataError` になる
- `src/loc.test.ts` に切り詰め・varint 不完全・正常系と空 roundtrip のテスト 6 件を追加した
- `CHANGES.md` の `## develop` に `[FIX]` を追記した
