# role=publish ハンドラが FORWARD 省略の REQUEST_UPDATE で Forward State を true に上書きする

- Priority: Low
- Created: 2026-08-12
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-publish-forward-omitted-overwrite
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-19 §10.2.17 の「If the parameter is omitted from REQUEST_UPDATE, the value for the subscription remains unchanged」に従い、FORWARD が省略された REQUEST_UPDATE を受信した場合に Forward State を変更しないよう修正する。

## 現状

- `bidiReadRequestStreamMessages` の role=publish 分岐 (`src/session/bidi.ts`) は、受信 REQUEST_UPDATE のパラメータに対して `extractForwardState(decoded.parameters)` を無条件適用し `publisher.setForwardState(forwardState)` を呼ぶ。
- `extractForwardState` (`src/session/params.ts`) は FORWARD パラメータが無い場合にデフォルト値 true を返すため、FORWARD 省略の REQUEST_UPDATE を受信すると Forward State が true に上書きされる。
- これは §10.2.17 の「REQUEST_UPDATE で省略時は不変」に反する。publisher が FORWARD=0 (オブジェクト送信停止) を受けて送信を止めた後、パラメータ無しの REQUEST_UPDATE が届くと送信が再開されてしまう。
- 同じ問題の受信 PUBLISH ストリーム側 (ケース 1、`bidiHandlePublishRequestUpdate`) は issue 0377 で「FORWARD パラメータが存在する場合のみ反映」に修正済みであり、role=publish ハンドラと非対称。
- 変更対象ファイル: `src/session/bidi.ts` (`bidiReadRequestStreamMessages` の role=publish 分岐)、`src/session/bidi.test.ts` (テスト追加)、`CHANGES.md`。

## 設計方針

- role=publish 分岐で FORWARD パラメータが存在する場合のみ `publisher.setForwardState` を呼ぶ (省略時は不変)。判定は FORWARD パラメータの存在チェック + `extractForwardState` の組み合わせとし、`bidiHandlePublishRequestUpdate` の実装 (issue 0377) と同パターンに揃える。
- `extractForwardState` 自体のデフォルト true 動作は変更しない (PUBLISH / PUBLISH_OK / SUBSCRIBE 等、省略時デフォルト 1 が正しい他メッセージでの使用に影響するため)。

## 完了条件

- FORWARD 省略の REQUEST_UPDATE を受信した場合、`publisher.forwardState` が変化しないこと。
- FORWARD を含む REQUEST_UPDATE を受信した場合、従来どおり反映されること。
- 上記を検証するテストがあること。
- `CHANGES.md` の `## develop` に `[FIX]` があること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

未着手。
