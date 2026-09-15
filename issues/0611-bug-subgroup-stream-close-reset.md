# Forward State と END_OF_GROUP で省略した Subgroup を reset せず FIN で閉じる

- Created: 2026-09-15
- Completed: {YYYY-MM-DD}
- Branch: feature/fix-subgroup-stream-close-reset
- Polished: {YYYY-MM-DD}

## 目的

draft-ietf-moq-transport-21 §11.3.2 は、Subgroup の全 Object を渡し切る前にストリームを閉じる場合に reset を MUST とし、その例に Forward State による Object の省略を明示的に挙げる。現状は Subgroup ストリームを閉じる経路が「Group 変更」「`done()`」「peer cancel」の 3 つしかなく、Forward State による省略を考慮せず FIN で閉じる。購読者は「Subgroup を最後まで受け取った」と誤認する。

## 現状

- Forward State が 0 の間、`publishSendObject` は送信せず resolve する (Object は省略される)。Forward State の変更 (`PublisherImpl.setForwardState`) はフラグとコールバックのみでストリームに触れない
- Group 変更時は `publishSendObjectInternal` が前のストリームを `writer.close()` (FIN) で閉じる
- `done()` 時は `publishClosePublisherStreamInternal` が `writer.close()` (FIN) で閉じる
- reset する経路は peer cancel 専用の `publishResetPublisherStream` のみ
- END_OF_GROUP status を送った時点でも §11.3.2 の FIN 条件が成立するが、FIN せず同一 Group への後続送信も拒否しない (`PublisherImpl` の送信ガードは END_OF_TRACK 後のみ拒否)
- 到達条件: Group G で 1 件以上送信してストリームが開く → REQUEST_UPDATE (FORWARD=0) を受信 → アプリが G の残り Object を `sendObject` (省略される) → Group 変更または `done()`

draft-ietf-moq-transport-21 §11.3.2:

> If a sender closes the stream before delivering all such objects to the QUIC stream, it MUST reset the stream. This includes, but is not limited to:
>
> *  Omitting a Subgroup Object due to the subscriber's Forward State

## 設計方針

- Subgroup 単位で「未送信の Object があるか」を保持し、閉じる経路を FIN と RESET で分岐させる。Forward State による省略、END_OF_GROUP status の送信、delivery timeout を同じ状態に写像する
- END_OF_GROUP status 送信後は FIN し、当該 Group への後続送信を拒否する
- §11.3.2 の「正常終了は FIN、途中終了は RESET」を判定する関数を 1 つに寄せ、閉じる経路ごとの判断を散らさない
- `closedSubgroups` は「閉じた Subgroup への送信拒否」用であり、未送信 Object の有無とは別の状態として扱う

## 完了条件

- Forward State による省略を含む Subgroup が RESET で閉じられる
- END_OF_GROUP status 送信後に FIN され、同一 Group への後続送信が拒否される
- 省略のない Subgroup は従来どおり FIN で閉じられる
- peer cancel 経路の RESET が変わらない
- テストがある
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 参照

- draft-ietf-moq-transport-21 §11.3.2 (Closing Subgroup Streams)
- draft-ietf-moq-transport-21 §11.1.2 (Object Status)
- draft-ietf-moq-transport-21 §3.1 (Subscriptions)
- draft-ietf-moq-transport-21 §5.2 (Delivery Timeouts and Data Reliability)
