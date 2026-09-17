# MediaPublisher の純粋ロジックを切り出してテストする

- Created: 2026-09-06
- Completed: 2026-09-17
- Branch: feature/add-media-publisher-tests
- Polished: 2026-09-17

## 目的

`createMediaPublisher` に対応テストがなく、グループ管理・キーフレーム判定等の純粋ロジックが private に埋没して検証できない。Subscriber 側と同様に切り出して pin する必要がある。

## 現状

- `src/createMediaSubscriber.test.ts` は存在するが `src/createMediaPublisher.test.ts` がない。
- `keyframeInterval` 境界、音声グループ周期、優先度定数等が未検証である。

## 設計方針

1. グループ管理・キーフレーム判定を純関数に切り出す (Subscriber 側の切り出し方針に合わせる)。
2. 切り出した関数の単体テストを追加する。

## 完了条件

- 純粋ロジックがテストで pin されること。
- `vp check` / `tsc --noEmit` / `vp test run` が通ること。

## 解決方法

`src/createMediaPublisher.ts` の private に埋没していたグループ管理とキーフレーム判定を純関数として切り出し、
`src/createMediaPublisher.test.ts` に単体テスト 15 件を追加した。挙動は変えておらず、既存テスト 28 件の期待値も
変えていない。切り出した関数は単体テスト用であり、`src/index.ts` の再エクスポートには含めない (パッケージ公開
API は変えない)。

### 切り出した純関数

- `resolveKeyframeInterval`: キーフレーム間隔の解決。`keyframeInterval` 未指定時は framerate の 2 倍 (framerate の
  既定値は 30 なので 60)、明示指定時はそちらを優先する
- `shouldSendKeyFrame`: フレーム番号が間隔の倍数かを判定する。`requestKeyframe()` がフレーム番号を 0 に戻すため、
  要求直後のフレームは必ずキーフレームになる
- `allocateAudioObject`: 音声フレーム 1 件分の Group / Object を払い出す。送信済みフレーム数が周期
  (定数 `AUDIO_GROUP_FRAME_PERIOD` = 50 フレーム、約 1 秒) に達したフレームで Group を進め、Object ID を 0 から
  振り直す
- `allocateVideoObject`: 映像フレーム 1 件分の Group / Object を払い出す。初回のキーフレームは割当済みの初期
  Group をそのまま使い、2 回目以降のキーフレームで Group を進めて Object ID を 0 に戻す。差分フレームは Group を
  進めない
- Publisher Priority の 3 定数 (`PRIORITY_AUDIO` = 192 / `PRIORITY_VIDEO_KEY` = 255 / `PRIORITY_VIDEO_DELTA` = 128)
  を export する

`MediaPublisherImpl` は Group ID / Object ID / フレーム数を保持し、これらの関数の戻り値で更新する。Group を進めたかを
`groupAdvanced` で返すため、送信済み最大 Group ID の追跡 (draft-ietf-moq-msf-01 §6.1) は呼び出し側に残している。

### 追加したテスト (15 件)

- キーフレーム間隔の解決 3 件: 映像オプション未指定・framerate 指定・keyframeInterval 明示指定 (framerate より優先)
- キーフレーム判定 2 件: フレーム番号 0 (初回・要求直後) と、間隔の倍数の前後 (59 / 60 / 61 / 119 / 120)
- 音声の Group 管理 4 件: 周期未満の Object ID 連番、周期到達での Group 加算と Object ID の振り直し、切り替え直後の
  継続、既定周期 50 フレームの境界 (49 フレーム目までは同じ Group)
- 映像の Group 管理 5 件: 初回キーフレーム、差分フレーム、2 回目以降のキーフレーム、差分のみでの Group 非加算、
  差分先行時の初回キーフレーム (初期値 + 1)
- Publisher Priority 1 件: `docs/HIGH_LEVEL_API.md` の Priority 表の値

### 起票時の「現状」との差異

`src/createMediaPublisher.test.ts` は既に存在しており (pause / resume の世代管理、stop / close の後片付け、Group ID の
割当て、Video / Audio Config の送信)、起票時の「対応テストがない」は実態と異なっていた。ただしグループ管理と
キーフレーム判定は private に埋没したままで、`keyframeInterval` の境界・音声グループ周期・優先度定数も未検証だったため、
「設計方針」の 2 項目 (純関数への切り出しと単体テストの追加) をそのまま実施した。

### 検証

- `vp check` 通過
- `tsc --noEmit` 通過
- `vp test run`: 105 ファイル / 2,374 テスト全通過 (2,359 → 2,374、+15)
- `vp run build` 通過
