# devtools の主要経路をテストする

- Created: 2026-09-06
- Completed: 2026-09-17
- Branch: feature/add-devtools-tests
- Polished: 2026-09-17

## 目的

主要動作経路が無テストで、Catalog 誤記や固定 Keyframe を検出できない体制である。検証可能な範囲をテストする必要がある。

## 現状

- `usePublisher` / `EncoderWrapper` / `DecoderWrapper` / `codec.ts` にテストがない。
- 既存テストは helper のみで、LOC 復号・描画・購読開始・要求フローを扱わない。
- 一部テストが `as never` スタブで AGENTS.md に反する。

## 設計方針

1. 純粋部・契約部からテストを追加する (Catalog 生成、codec 解決、開始フローの純粋部)。
2. `as never` を規約適合の形に直す (fake 明示化または統合経路寄せ)。

## 完了条件

- 主要経路の退行がテストで検出できること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

主要経路の純粋部・契約部を切り出してテストを追加し、devtools のテストにあった `as never` スタブを
規約適合の Fake に置き換えた。

### 追加・変更したテスト

- `devtools/src/hooks/usePublisher.test.ts` (新規 15 件)
  - `buildPublisherCatalog`: 設定値が video トラックの各フィールド (`packaging` / `isLive` / `role` / 解像度 / フレームレート / ビットレート) に反映されること、codec 文字列が `getEncoderConfig` の対応表と一致すること (Catalog 誤記の検出)、`encodeCatalog` → `decodeCatalogMessage` の往復 (draft-ietf-moq-msf-01 §5.1)
  - `buildObjectSendPlan`: キーフレームで新しい Group を開始して Object ID を 0 に戻すこと、デルタフレームが同じ Group の続きになること、priority (キーフレーム 255 / デルタ 128)、LOC Properties の timestamp / VIDEO_FRAME_MARKING (TID=0 による B 抑圧を含む) / Video Config、payload が chunk の data をそのまま使うこと
  - `shouldRequestKeyFrame`: 先頭フレームと `keyframeInterval` ごとに true、間隔の途中は false (固定 Keyframe の検出)
  - `stopPreview` / `togglePreview` の signal 巻き戻しと映像ストリームの解放、`startPreview` が不正な解像度で映像ストリームを取得せずエラー表示にすること
- `devtools/src/hooks/useSubscriber.test.ts` (11 件追加、`as never` を全廃)
  - `buildVideoDecoderConfig`: codec / codedWidth / codedHeight の反映、任意フィールド (width / height) を載せないこと、codec 未指定の例外、`initRef` → Initialization Data (Base64) の description 復元と解決失敗時
  - `parseLocFrameMetadata`: publisher が付与した LOC Properties を subscriber が解釈できること (モジュール横断の契約)、Properties が無い / 空 / TIMESTAMP のみの扱い
  - `resolveNewGroupRequestValue`: 最大 Location + 1、未知なら 0 (draft-ietf-moq-transport-21 §9.20.20)
  - `resetSubscriberStats`: 統計値のリセット
- `devtools/src/utils/EncoderWrapper.test.ts` (新規 4 件) / `devtools/src/utils/DecoderWrapper.test.ts` (新規 6 件)
  - configure 前の状態機械 (unconfigured・encodeQueueSize・生成時に Worker を起動しない・close の冪等・reset / resetKeyframeWait が例外を投げない)
- `devtools/src/utils/codec.test.ts` (2 件追加)
  - `getEncoderConfig` が codec ごとに解像度・フレームレート・ビットレートと入力形式 (avc / hevc の annexb) を返すこと、不明な codec の vp8 フォールバック
- `devtools/src/testSupport/fakes.ts` (新規)
  - `as never` の置き換え先。`FakeSubscriber` / `FakeSession` は公開インターフェースを実装し、呼び出しをラベル付きで記録する。`DecoderWrapper` は private フィールドを持つためインターフェース実装の Fake では置き換えられず、実クラスを継承した `RecordingDecoderWrapper` で close だけを記録する
  - `devtools/src/signals/subscriber.test.ts` と `devtools/src/hooks/useSubscriber.test.ts` の `as never` 18 箇所をすべて置き換え、後始末フローの順序 (decoder.close → catalog の unsubscribe → session.close) と unsubscribe 失敗時の継続を従来どおり検証する

### テストできなかった経路

Node の vitest には WebCodecs / WebTransport / canvas / Dedicated Worker / DOM が無いため、以下は対象外とした。
理由はテストファイルの冒頭コメントとテスト用 Fake のコメントにも明記している。

- `EncoderWrapper` / `DecoderWrapper` の configure・encode・decode と Worker メッセージの往復:
  `VideoEncoder` / `VideoDecoder` / `Worker` が未定義で `ReferenceError` になる。実ブラウザでの
  wrapper の契約は `tests/e2e/codec-wrappers.spec.ts` が実 Chromium で検証している
  (対象はライブラリ側の `src/codec` の wrapper であり、devtools 側の wrapper は未検証のまま)
- `usePublisher.startPreview` (ダミー映像) / `startPublishing` / `stopPublishing`:
  `connect` (WebTransport) と `createDummyVideoStream` (`document.createElement("canvas")` と
  MediaStreamTrackGenerator) が必要
- `usePublisher` の `handleEncodedChunk` 本体: 送信には `Publisher` (WebTransport セッション) が必要なため、
  純粋部の `buildObjectSendPlan` を検証対象にした
- `useSubscriber` の `startSubscribing` / `stopSubscribing` / `handleObject` / `renderFrame` /
  `requestKeyframe` 本体: `useSubscriber` は Preact のフック (`useRef` / `useEffect`) を使っており、
  コンポーネント外から呼ぶと `TypeError` になる (renderer が必要)。加えて `connect` /
  `EncodedVideoChunk` / canvas 2D コンテキストが必要。`requestKeyframe` は純粋部の
  `resolveNewGroupRequestValue` と DYNAMIC_GROUPS 判定 (ライブラリ側でテスト済み) を対象にした

### 退行検出の裏付け

追加したテストが実際に退行を検出することを、実装を一時的に壊して確認した (確認後に元へ戻している)。

- `shouldRequestKeyFrame` を常に true にする (全フレームをキーフレームにする) と 1 件失敗する
- `buildObjectSendPlan` の `isIndependent` を常に true にする (固定キーフレーム) と
  publisher 側 1 件 + subscriber 側のモジュール横断テスト 1 件が失敗する
- `buildPublisherCatalog` の codec を固定文字列にする (Catalog 誤記) と 2 件失敗する

### 検証

- `vp check` 通過
- `tsc --noEmit` 通過
- `vp test run`: 108 ファイル / 2,397 テスト全通過 (追加前は 105 ファイル / 2,359 テスト。
  テストファイル 3 件追加、テスト 38 件増)
- `vp run build` 通過
- `CHANGES.md` の `## develop` の `### misc` に `[UPDATE]` を追加した
