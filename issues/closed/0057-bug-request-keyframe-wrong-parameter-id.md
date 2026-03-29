# requestKeyframe の NEW_GROUP_REQUEST パラメータ ID が不正

Created: 2026-03-29
Model: Opus 4.6

## 概要

`requestKeyframe()` で使用している NEW_GROUP_REQUEST のパラメータタイプが `0x0c` になっているが、draft-17 では `0x32` と定義されている。このため `requestKeyframe()` は必ず実行時エラーになる。

## RFC 根拠

draft-ietf-moq-transport-17 Section 14.3 Table 11 Message Parameters:

```
+================+=====================+================+
| Parameter Type | Parameter Name      | Specification  |
+================+=====================+================+
| 0x02           | DELIVERY_TIMEOUT    | Section 9.3.3  |
+----------------+---------------------+----------------+
| 0x03           | AUTHORIZATION_TOKEN | Section 9.3.2  |
+----------------+---------------------+----------------+
| 0x04           | RENDEZVOUS_TIMEOUT  | Section 9.3.4  |
+----------------+---------------------+----------------+
| 0x08           | EXPIRES             | Section 9.3.8  |
+----------------+---------------------+----------------+
| 0x09           | LARGEST_OBJECT      | Section 9.3.9  |
+----------------+---------------------+----------------+
| 0x10           | FORWARD             | Section 9.3.10 |
+----------------+---------------------+----------------+
| 0x20           | SUBSCRIBER_PRIORITY | Section 9.3.5  |
+----------------+---------------------+----------------+
| 0x21           | SUBSCRIPTION_FILTER | Section 9.3.7  |
+----------------+---------------------+----------------+
| 0x22           | GROUP_ORDER         | Section 9.3.6  |
+----------------+---------------------+----------------+
| 0x32           | NEW_GROUP_REQUEST   | Section 9.3.11 |
+----------------+---------------------+----------------+
```

`src/message/types.ts` でも `NEW_GROUP_REQUEST: 0x32` と正しく定義されているが、devtools と createMediaSubscriber でハードコードされた `0x0c` が使われている。

## 該当箇所

- `devtools/src/hooks/useSubscriber.ts` 行 744-753: `type: 0x0c` を使用
- `src/createMediaSubscriber.ts` 行 231: 同様に `0x0c` を使用

## 修正方針

ハードコードされた `0x0c` を `MessageParameterType.NEW_GROUP_REQUEST` (0x32) に修正する。

## 解決方法

Completed: 2026-03-29

- `devtools/src/hooks/useSubscriber.ts` と `src/createMediaSubscriber.ts` でハードコードされた `0x0c` を `0x32` に修正した
- コメントの draft-15 参照を draft-17 Section 9.3.11 に更新した
