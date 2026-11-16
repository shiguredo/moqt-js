# cipherSuite の必須条件を moq-secure-objects のときに限定する

- Created: 2026-11-16
- Completed: 2026-11-16
- Branch: feature/update-msf-draft-02
- Polished: {YYYY-MM-DD}

## 目的

draft-02 §5.2.39 は「This field MUST be present when the encryptionScheme is "moq-secure-objects".」と定める。draft-01 は「MUST be present when encryptionScheme is specified」であり、任意の scheme で `cipherSuite` を要求していた。現行実装は draft-01 の条件のままなので、custom encryption scheme を使う draft-02 の catalog を誤って拒否する。Appendix A.1.3 も「cipherSuite is now required only when encryptionScheme is "moq-secure-objects".」と変更を明記している。

## 現状

- `src/msf/catalogTrackValidation.ts` の `pickEncryptionFields` は、`encryptionScheme` が指定されていれば `cipherSuite` を必須にする
- そのため `"encryptionScheme": "com.example.custom-encryption"` だけを持つ track が `cipherSuite must be present when encryptionScheme is specified` で拒否される
- `docs/investigations/msf-draft-02-diff/verify.mjs` の該当ケースがこの挙動を検出している

## 設計方針

- `cipherSuite` の必須条件を `encryptionScheme === "moq-secure-objects"` のときに限定する
- `cipherSuite` 単独 (encryptionScheme なし) は現行どおり受理する。§5.2.39 は scheme に紐づく値の必須条件を定めるものであり、単独の宣言を禁止していない
- エラー文言から「encryptionScheme 指定時」という draft-01 の条件を外す

## 完了条件

- `encryptionScheme` が `moq-secure-objects` で `cipherSuite` が無い track を拒否する。単体テストで固定する
- `encryptionScheme` が `moq-secure-objects` 以外で `cipherSuite` が無い track を受理する。単体テストで固定する
- `moq-secure-objects` で `cipherSuite` を持つ track を受理する。単体テストで固定する
- `npx vp check` / `npx tsc --noEmit` / `npx vp test --run` が通る

## 解決方法

- `src/msf/catalogTrackValidation.ts` の `pickEncryptionFields` で、`cipherSuite` を必須にする条件を `encryptionScheme === "moq-secure-objects"` のときに限定した
- custom encryption scheme は `cipherSuite` を要求せず、`moq-secure-objects` では引き続き必須にした
- エラー文言を draft-02 §5.2.39 の条件に合わせ、custom scheme / cipherSuite ありの受理を単体テストで固定した
