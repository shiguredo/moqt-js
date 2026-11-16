# initDataList の type と初期化 property の宣言を実装する

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 §5.1.7 Table 3 は `initDataList` の type に `inline` に加えて `track-property` と `object-property` を定義し、§12.2 は Object property で初期化データを送る track に `object-property` を指す `initRef` を MUST で要求する。実装は `inline` しか扱っておらず、高レベル publisher は VIDEO_CONFIG / AUDIO_CONFIG を Object property で送りながら `initRef` を出していない。

## 現状

- `src/msf/catalogValidation.ts` の `validateInitDataEntry` は `type` を任意の string として受理する
- `src/msf/tracks.ts` の `resolveInitData` は `type !== "inline"` で `undefined` を返す
- `src/msf/types.ts` と `src/msf/tracks.ts` のコメントは「inline のみ」と書いており、Table 3 と食い違う
- `src/createMediaPublisher.ts` は VIDEO_CONFIG (0x0D) / AUDIO_CONFIG (0x0F) を Object property として送るが、`initDataList` も `initRef` も catalog に載せない

## 設計方針

- `initDataList` の `type` を Table 3 の 3 値に限定し、`id` の一意性と非空、`data` の型を検証する
- `data` の形式は Table 3 の「hex notation」を厳密に解釈せず、文字列として保持する。形式の解釈は利用者に委ねる
- `src/msf/tracks.ts` に `resolveInitDataEntry(catalog, track)` を追加し、type ごとに `inline` は Base64 文字列、property 型は property type の hex 表記を返す。既存の `resolveInitData` は inline の Base64 を返す挙動を維持し、JSDoc で property 型を扱わないことを明記する
- 高レベル publisher は、初期化データを Object property で送る track に `object-property` の `initDataList` エントリと `initRef` を載せる。`data` は `0x0d` / `0x0f` の hex 表記とし、その形式を JSDoc に書く

## 完了条件

- `initDataList` の type が 3 値以外なら拒否する。単体テストで固定する
- `id` の重複と空文字列を拒否する。単体テストで固定する
- `resolveInitDataEntry` が type ごとに異なる結果を返す。単体テストで固定する
- 高レベル publisher が出す catalog に、音声 / 映像それぞれの `object-property` エントリと `initRef` が載る。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 解決方法

- `src/msf/types.ts` の `InitDataEntry.type` を `inline` / `track-property` / `object-property` の 3 値にし、§5.1.7 Table 3 と一致させた
- `src/msf/catalogValidation.ts` の `validateInitDataEntry` で、type の値集合、id の非空、property 型の `data` の hex 表記を検証するようにした
- `src/msf/tracks.ts` に `resolveInitDataEntry` を追加し、type ごとの `data` の意味 (inline は Base64、property 型は property type の hex 表記) を返すようにした。既存の `resolveInitData` は inline 専用のまま
- `src/createMediaPublisher.ts` が catalog に `object-property` の `initDataList` エントリ (audio 0x0f / video 0x0d) を載せ、各 track に `initRef` を付けるようにした (§12.2 の MUST)
- `src/msf/variables.ts` の `initDataList` 置換から `type` を外した (列挙値を変数で置換すると Table 3 外の値になり得る)
