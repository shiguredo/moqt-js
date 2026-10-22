# SUBSCRIBE を維持したまま fill / FETCH で欠落を回復する仕組みの検討

SUBSCRIBE を維持したまま、配信経路の障害で欠落した Object を fill fetch または FETCH で
取得する仕組みを、MOQT draft-22 の仕様、moqt-js の実装、sora-moq の実装の 3 つを突き合わせて
検討した記録である。

- 調査日: 2026-10-22
- moqt-js: `f770493d` (develop)
- MOQT: draft-ietf-moq-transport-22 (2026-10-01)
- MSF: draft-ietf-moq-msf-01 (2026-06-02)
- sora-moq: `c8cd73e0` (feature/refactor-inets-to-cowboy-gun)。REQUEST_UPDATE の fill が
  現行版では未実装であることと、FETCH が cache と上流で処理されることは origin/develop の
  `ed737286` でも同じであることを確認した
- sora-moq の fill fetch stream (REQUEST_UPDATE + FILL_PARAMETERS) は実装予定である
  (2026-10-22 の申し送り)。本検討では、実装後は fill を第一候補にし、FETCH をフォールバック
  にする
- sora-moq の issue 1289 の申し送り (2026-10-22): subgroup stream が reset された後、同じ
  (Group ID, Subgroup ID) の続きが別の stream で届く。欠けは stream をまたいで
  (Group ID, Subgroup ID) ごとに見る。この申し送りにより、旧記述の「cluster が graft と
  link_resume で 5 秒まで修復する」は置き換わる

この文書は検討の記録であり、実装ではない。`src/` と `tests/` は変更していない。4.4 と
6.3 の cluster の記述は、sora-moq の issue 1289 の申し送りを正とする。

以下、1288 / 1289 と書いた場合は sora-moq の issue を指す。moqt-js の issue ではない。
moqt-js 側で実装 issue を切る場合は、別の番号を使う。

## 1. 結論

| 項目                  | 結論                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 仕様適合              | 可能である。SUBSCRIBE を維持したまま、同じセッションで FETCH を送れる。REQUEST_UPDATE + FILL_PARAMETERS で fill fetch stream も開ける                        |
| 使う方式              | 現行の sora-moq では standalone FETCH を使う。sora-moq の fill fetch stream 実装後は、購読中の穴埋めに fill を第一候補にし、FETCH をフォールバックにする     |
| sora-moq 側の追加実装 | fill fetch stream (REQUEST_UPDATE + FILL_PARAMETERS) の実装が予定されている。FETCH は cache、所有ノードの cache、publisher の 3 段で処理される               |
| クライアント側の実装  | 可能である。`session.fetch` と `Subscriber.update({ fill })` を同じ Controller の transport として扱う。欠落の検出、重複排除、期限、フィルタの扱いを設計する |
| 主な効果              | subgroup stream の reset 後に別の stream で続きが届く場合の欠落、datagram の欠落、last mile の datagram 欠落を、Object が cache に残っている間に取り戻せる   |
| 回復できないもの      | publisher の終了で cache が破棄された後、cache から evict された古い Object、セッション断と GOAWAY、malformed track、順序そのものの修復、ペイロードの真正性  |

要点は次の 3 つである。

1. draft-22 は、購読中の欠落を FETCH または fill で取り直す使い方を明示的に想定している。
   §2.3.1 は Group の欠落を Fetch upstream で埋められるとし、§9.5.1 は Largest Object 以下の
   Object を FETCH で取得できるとする。§3.4 / §9.5.1 は REQUEST_UPDATE の FILL_PARAMETERS で
   新しい fill fetch stream を開けるとする
2. sora-moq は FETCH を cache と上流の両方で処理し、cluster では所有ノードの cache まで
   取りに行く。初期 fill は実装している。REQUEST_UPDATE で FILL_PARAMETERS を受けたときの
   fill fetch stream は現行版では未実装だが、実装予定である (`docs/moqt_relay.md` の
   「未実装の範囲」)
3. sora-moq 1289 では、subgroup stream が reset された後、同じ (Group ID, Subgroup ID) の
   続きが別の stream で届く。欠けは reset された stream の最後に処理できた Object と続きの
   stream の最初の Object の間として明示的に分かる。subgroup は猶予を置かずに回復要求を
   出す。猶予が要るのは datagram と、続きの stream が来ない場合だけである。OBJECT_DATAGRAM は
   再送なしの直接配送なので、クライアント側の fill / FETCH はこの穴も埋める

## 2. 問題の定義

「断」「順番が保証されない」「データが破損する」を 1 つの問題として扱うと、できることと
できないことが混ざる。まず障害を分ける。

| 障害                     | 例                                                 | fill / FETCH で回復できるか                                                                                |
| ------------------------ | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| セッション断             | WebTransport の切断、GOAWAY 後の移行               | できない。再接続か GOAWAY の移行が必要                                                                     |
| 購読の終了               | PUBLISH_DONE、UPDATE_FAILED、TOO_FAR_BEHIND        | できない。過去 Object を FETCH で取れる場合もあるが、live は終わっている                                   |
| Object の欠落            | datagram の損失、cluster link の datagram 損失     | できる。Object が cache か上流にあれば                                                                     |
| Subgroup stream の reset | delivery timeout、buffer 上限、cluster の経路障害  | できる。reset 後に同じ (Group ID, Subgroup ID) の続きが別の stream で届く。欠けた Object を FETCH で取れる |
| Group の欠落             | 経路障害で Group 全体が届かない                    | できる。Group の範囲を指定して FETCH する                                                                  |
| 途中までの Object        | stream reset で Object の途中バイトが捨てられた    | できる。完全な Object を FETCH で取れる                                                                    |
| 順序の逆転               | 異なる Subgroup、異なる Group、datagram の追い越し | できない。FETCH は欠落を埋めるだけで、順序を直さない。受信側が Location で並べる                           |
| ペイロードの破損         | relay がバイト列を改変した、送信元が違う           | できない。MOQT の範囲外であり、end-to-end 保護が要る                                                       |

「順番が保証されなくなった」は、多くの場合「欠落した Object の前後が前後関係なく届く」ことを
指す。MOQT はもともと Group と Subgroup をまたぐ順序を保証しない (§2.1 / §2.3.1)。FETCH で
回復できるのは欠落であり、順序ではない。順序が要る用途は、受信側が Group ID、Object ID、
LOC の TIMESTAMP で並べる。moqt-js のメディア経路は `VideoDecodeOrder` と playout の
時間軸でこれを扱っている。

「データが破損する」のうち、バイト列の改変は FETCH では直せない。draft-22 §2.1 は Object の
バイト列が取得経路によらず同一であることを求め、§7.8 は relay が payload を変更しては
ならないとする。しかし §15.4 は、relay は Object に触れられるため、end-to-end で保護しない
限り意図的にも偶発的にも改変され得ると明記している。QUIC と TLS が守るのは hop ごとの
完全性であり、送信元の真正性ではない。この領域は Secure Objects などの end-to-end 保護の
担当であり、FETCH の担当ではない。

## 3. 仕様の整理

### 3.1 SUBSCRIBE と FETCH / fill の関係

SUBSCRIBE は継続的な配信の関係であり、FETCH は既存 Object の有限な範囲取得である
(§3 冒頭)。どちらも同じセッションで並行して使える。FETCH は新しい bidi request stream を
開き、新しい Request ID を消費する (§6.4.2.1)。FETCH は購読の状態を変えず、購読も FETCH の
状態を変えない。

fill は SUBSCRIBE または subscription への REQUEST_UPDATE に FILL_PARAMETERS を載せて要求
する。publisher は FETCH_HEADER で始まる unidirectional stream (fill fetch stream) を開き、
FETCH と同じ framing で Object を届ける (§3.4)。fill は購読に紐づくため、購読の認可、
優先度、フィルタを継承する。

FETCH が取得できるのは、要求を処理した時点の Largest Object 以下の Object である (§3.2)。
Largest Object より後ろの Object は FETCH では取れない。これは live の先頭を FETCH で
追いかける用途には使えず、先頭は SUBSCRIBE が担うという役割分担になる。

FETCH の応答は 1 本の unidirectional stream で届き、要求された Group Order の順、Group 内は
Object ID の順に並ぶ (§3.2.1)。応答の終端は FETCH_OK の End Location で示される (§9.12)。
要求範囲が Largest Object を超える場合、End Location は Largest Object に切り下げられる。

### 3.2 fill fetch と、実装後の扱い

SUBSCRIBE または subscription への REQUEST_UPDATE に FILL_PARAMETERS (§9.20.15) を載せると、
publisher は FETCH_HEADER で始まる unidirectional stream を開き、fill range の Object を
配る (§3.4)。これが fill fetch stream である。fill range は FILL_PARAMETERS 内の
LOCATION_FILTER、省略時は購読の Location Filter で決まり、Largest Object でクランプされる。
購読の Location Filter とは独立に指定できるため、購読を Next Group から始めつつ、その手前の
Group を fill で取るといった使い方ができる (§3.5)。

fill fetch には REQUEST_ERROR が無く、失敗は stream の reset で伝える。reset や cancel は
購読に波及しない (§3.4.1)。購読中に複数の fill fetch stream を同時に開ける (§3.4)。

仕様上は、購読中の穴埋めに REQUEST_UPDATE + FILL_PARAMETERS を使える (§9.5.1)。sora-moq の
現行実装は、購読の確立時に FILL_PARAMETERS を処理するだけで、確立後の REQUEST_UPDATE に
載った FILL_PARAMETERS では fill fetch stream を開かない。詳細は 4.1 に書く。ただし
sora-moq は fill fetch stream の実装を予定しており、実装後は fill を第一候補にする。

fill の方が購読と同じ認可、優先度、フィルタを継承でき、FETCH の request stream を別に
立てなくて済む。購読中の穴埋めという意味でも、§9.5.1 の fill が自然である。現行版では
fill が来ないため、実装済みの standalone FETCH を先に使い、fill の実装後に切り替える。
両方を同じ Controller の transport として扱い、fill が失敗したら FETCH にフォールバック
する。

### 3.3 Object の状態と gap の意味

Object には 3 つの状態がある (§2.1.2)。

1. 存在しないことが確定した状態。この状態は永久であり、存在しないという信号は権威である
2. 存在することが確定した状態。存在から不存在へは遷移できるが、その逆はない
3. 状態が不明な状態。まだ受信していないか、まだ生成されていない

Object ID の飛びは、それだけでは何も意味しない。飛んだ Object は、受信するか、存在しない
ことが通知されるまで unknown である (§2.1.2)。Group ID も同じで、Group 内の Object を
受信するまで Group の存在は推論できない (§2.3.1)。

存在しないことの通知には、次のものがある。

- SUBSCRIBE 経路の Object Status: END_OF_GROUP (0x3) は、その Object ID 以上の Object が
  Group 内に存在しないことを示す。END_OF_TRACK (0x4) は、その Location 以上の Object が
  Track に存在しないことを示す (§11.1.1)
- Prior Group ID Gap (0x3C) / Prior Object ID Gap (0x3E): 直前の Group / Object が存在しない
  ことを示す。publisher が任意で付ける (§10.8 / §10.9)
- FETCH の End of Range: 0x8C は非存在、0x10C は unknown、0x20C は timed out を示す
  (§11.4.1.2)
- FETCH の通常の gap: Range Filter を送っていなければ非存在、送っていれば unknown を示す
  (§3.2.2)

FETCH の応答で gap を表現する方法は 2 つある。End of Range を明示する方法と、Location の
飛びで暗黙に示す方法である。暗黙の gap は FIN でしか末尾を確定できない (§3.2.2)。この
区別は、クライアントが「存在しない Object を取りに行かない」「unknown の Object を再試行
する」ために要る。ただし moqt-js の現在の受信実装は End of Range をアプリへ通知せずに
読み飛ばしている (5.3)。

### 3.4 Relay と cache

Relay は Object を cache してよいが、必須ではない (§7.1)。cache に Object を保持する場合、
Full Track Name、Group ID、Object ID で識別する。publisher は MAX_CACHE_DURATION (0x04) で
cache に置ける時間を指定できる。指定を過ぎた Object は relay が転送してはならず、状態は
unknown になる (§10.3)。

Relay は FETCH の範囲に cache から配れる Object があれば直ちに送ってよい。手元に無く状態が
unknown の Object があれば、上流へ 1 つ以上の FETCH を出す (§3.2.3)。FILL_TIMEOUT は、
その上流 FETCH に使ってよい合計時間である。使い切ったら、残りを timed out の gap として
報告し、配れる Object の配信を続ける (§3.2.3 / §9.20.5)。

Relay が FILL_PARAMETERS 付きの SUBSCRIBE を受けた場合、fill range を cache から配り、
足りない分を上流の SUBSCRIBE with FILL_PARAMETERS か FETCH で取りに行く (§7.6)。これは
relay の責務であり、クライアントは意識しない。

複数の publisher が同じ Track を出している場合、relay は FETCH を少なくとも 1 つの
publisher へ送る (§7.6)。同じ Track の Object は scope 内で一意であり、どの publisher から
取っても同じバイト列でなければならない (§2.1 / §2.5)。

Relay は multi-object stream で受けた Object を並べ替えたり落としたりしてはならない
(§7.4)。これは hop ごとの保証であり、経路全体の順序や完全性の保証ではない。

### 3.5 順序

MOQT は Group と Subgroup をまたぐ順序を保証しない。Subgroup 内は Object ID の昇順で、
1 本の stream に載る (§2.2)。FETCH の応答は要求された Group Order の順、Group 内は Object ID
の順である (§3.2.1)。SUBSCRIBE の配信は、Group Order と優先度に従うが、異なる Subgroup や
Group の間の到着順は保証されない。

同じ Subgroup の Object が別の stream で届くことは、先の stream が途中で reset された場合に
限り許される (§2.2)。sora-moq 1289 はこの許容を使う。受信側は、同じ (Group ID, Subgroup ID)
の続きが別の stream で届いても、プロトコル違反として扱わない。

したがって、FETCH で欠落を埋めても、購読で届く Object と FETCH で届く Object の到着順は
保証されない。受信側は Location で並べる必要がある。並べるための材料は Group ID、Object ID、
Object Status、LOC の TIMESTAMP である。

### 3.6 仕様適合性の評価

SUBSCRIBE を維持したまま FETCH を送ることは、仕様に沿う。draft-22 は §2.3.1 で
「cache の gap は必要なら Fetch upstream で埋められる」とし、§9.5.1 で「Largest Object 以下の
Object は FETCH で取得できる」とする。FETCH は購読とは独立した要求であり、購読を止めたり
変更したりしない。

fill も仕様に沿う。SUBSCRIBE または REQUEST_UPDATE に FILL_PARAMETERS を載せると、publisher
は fill range の Object を fill fetch stream で届ける (§3.4)。既存 Subscription の
REQUEST_UPDATE で fill を要求できる (§9.5.1)。購読は継続し、fill の失敗は購読に波及しない
(§3.4.1)。

この仕組みが保証するのは「存在する Object を、存在する場所から取れる」ことだけである。
存在しない Object、cache から消えた Object、publisher が保持していない Object は取れない。
また、順序とペイロードの真正性は保証しない。この限界は仕様の欠陥ではなく、役割の違いで
ある。

## 4. sora-moq の実装確認

ここが今回の検討で最も重要な部分である。sora-moq のコードを確認した結果、使える方式が
決まった。

### 4.1 fill は現行版では購読の確立時だけ

sora-moq は SUBSCRIBE の FILL_PARAMETERS を `subscribe_fill_request/1` で解釈し、購読の
確立時に `maybe_start_fill_stream/6` で fill fetch stream を開く。呼び出し元は
`join_upstream_subscription` と `establish_downstream_subscribers` の 2 つだけである。

確立後の REQUEST_UPDATE は `handle_downstream_request_update` から
`apply_downstream_request_update`、`apply_downstream_update` へ進む。ここでは
FILL_PARAMETERS を含む parameter を検証して REQUEST_OK を返すが、fill fetch stream は
開かない。`docs/moqt_relay.md` の「未実装の範囲」にも
「REQUEST_UPDATE で FILL_PARAMETERS を受けたときの fill fetch stream は未実装である。
fill fetch stream を開くのは購読の確立時だけである」と明記されている。

つまり、購読中に FILL_PARAMETERS を載せた REQUEST_UPDATE を送ると、REQUEST_OK は返るが
fill fetch stream は開かれない。クライアントは成功したと誤認して待ち続けるため、現行版では
この経路を設計に入れない。ただし sora-moq は fill fetch stream の実装を予定している。
実装後はこの制約はなくなり、購読中の穴埋めに使える。

初期 SUBSCRIBE の fill は、cache だけで fill range を覆える場合は cache から、覆えない場合は
`open_upstream_fill_stream` で上流へ FETCH を出す。これは途中参加の購読には有用だが、
現行版では確立済みの購読の穴を埋める用途には使えない。fill の実装後は、REQUEST_UPDATE の
fill でも同じ cache / upstream の経路が使えることが期待できる。ただし fill の完了通知、
同時に開ける fill の本数、REQUEST_UPDATE の fill の範囲の解釈は、実装時に確認する。

### 4.2 FETCH は cache、所有ノード、publisher の 3 段で処理される

sora-moq の FETCH は `cache_fetch_response/5` で自分の cache を引き、要求範囲を cache だけで
覆えれば cache から応答する。覆えなければ `forward_fetch_upstream/7` で上流へ 1:1 転送する。
cluster では、購読ノードの replica が所有ノードの cache へ cross-node FETCH を送り、
所有ノードでも miss なら publisher へ上流 FETCH を出す (`docs/cluster.md` の「cache」と
「2 段構成の実装」)。

FETCH の範囲指定は、`moqt_subscription:fetch_start_location/2` と
`fetch_end_location/2` が解決する。Location Filter の Type 0x02 (絶対開始)、0x03 (絶対開始と
Group 終端)、0x04 (絶対範囲) を扱える。Type 0x03 は Group の終端 Object を知らなくても
Group 単位で取得できるため、Group 全体が欠けた場合に使いやすい。

次の機能も実装されている。

- `MAX_CACHE_DURATION` を過ぎた Object は cache から配らず、上流へ回す (§10.3)
- FILL_TIMEOUT の予算を上流 FETCH に適用し、予算切れを timed out の gap として報告する
  (§3.2.3 / §9.20.5)
- FETCH 応答の End of Range マーカーを中継する (§11.4.1.2)
- FETCH_OK の End Location を Largest Object でクランプする (§9.12)
- FETCH の開始位置が Largest Object を超える場合は INVALID_RANGE を返す (§3.2)
- cache が覆えない場合に上流へ 1:1 転送する。部分カバーの混在応答は未実装だが、今回の
  小さい欠落範囲では cache が覆うか、全体を上流へ回すかのどちらかで足りる

関連するテストは `test/sora_moq_wt_h2_tests.erl` にある。cache からの FETCH、INVALID_RANGE、
End Location のクランプ、cache 期限切れ、上流 FETCH の転送、End of Range の中継などが
固定されている。

### 4.3 cache の既定値

sora-moq の cache は既定で有効である (`docs/conf.md`)。

| 設定                              | 既定値 | 意味                                                           |
| --------------------------------- | ------ | -------------------------------------------------------------- |
| `cache_enabled`                   | `true` | 受信した Object を保持する                                     |
| `cache_prewarm`                   | `true` | 購読者が 0 人でも上流の購読を FORWARD=1 に保ち、cache を温める |
| `cache_max_bytes`                 | 1 GiB  | relay 全体の payload と Object Properties の合計上限           |
| `cache_max_track_bytes`           | 64 MiB | Track ごとの上限                                               |
| `cache_replay_max_pinned_percent` | 25 %   | replay のために固定する量の上限                                |

直近の Object は edge の local cache に残る。30 Mbps の映像なら 64 MiB は約 18 秒分、
10 Mbps なら約 54 秒分、音声 (数十 kbps) なら数時間分に相当する。欠落を検出して数秒以内に
FETCH する用途では、十分な大きさである。

publisher の session が終了すると、その Track の cache は即座に破棄される。publisher が
存在しない Track は、cache に残っていても FETCH では取れない。ここは「配信側が死んでいる」
場合であり、FETCH の対象外である。

### 4.4 cluster の subgroup は reset 後に別の stream で続きが届く

sora-moq 1289 の申し送りでは、subgroup stream が途中で reset された後、同じ
(Group ID, Subgroup ID) の続きが別の stream で届く。これは draft-22 §2.2 が許す動きであり、
プロトコル違反ではない。受信側は次のように扱う。

- 欠けは stream ごとではなく、(Group ID, Subgroup ID) ごとに、stream をまたいで Object ID で
  見る
- reset された stream の最後に処理できた Object と、続きの stream の最初の Object の間が
  欠けた範囲になる
- この合図は明示的に届く。subgroup については検出の猶予時間を置かず、範囲が分かった時点で
  すぐ回復要求を出してよい (現行版は FETCH、fill 実装後は fill)
- 猶予が要るのは、datagram と、続きの stream が来ないまま止まっている場合だけである
- ブラウザが RESET_STREAM_AT に対応しない場合、reset された stream の最後の Object は
  確実には分からない。確実に処理できた最後の Object から取得すれば戻れる。最後の
  Object が重複して届く可能性があるため、Location で排除する
- reset された stream で Object を 1 つも処理していない場合、最初の Object ID が分からない。
  この場合の開始位置は 1288 / 1289 で決める必要がある

OBJECT_DATAGRAM は subgroup stream ではなく、再送もない。`broadcast_datagram/2` のコメントに
「datagram は再送が無く、Plumtree に載せると重複配送の害が大きい」とあり、全 replica へ
直接送るだけで、連番による欠番検出や graft の対象にしていない。cluster link で datagram が
落ちると、その Object は replica に届かず、下流のクライアントにも届かない。

datagram は relay の cache に積まれる (`cache_store_datagram/4`)。edge の cache に無くても、
cluster の所有ノードの cache にはある可能性が高い。クライアントが Group ID / Object ID の
欠落を検出して fill / FETCH を出せば、所有ノードの cache から取得できる。datagram は明示的な
reset の合図が無いため、検出には猶予時間が要る。

旧記述の「cluster が graft と link_resume で 5 秒まで修復する」は、1289 の申し送りで置き
換わる。クライアントは cluster の内部修復の期限を前提にせず、reset と続きの stream の
到着で欠落を判断する。

#### 4.4.1 1288 / 1289 で確定した点と、残る確認点

1289 で決定済みの点と、moqt-js 側で実装するために確認したい点を分けて書く。

1. Object ID は Group 内で共有され、Subgroup ごとに連続とは限らない。欠けた Object ID の
   範囲には、他の Subgroup の Object が含まれ得る。fill / FETCH の応答を Subgroup ID で
   選別できるようにするか、SUBGROUP_FILTER を fill / FETCH へ通すか、余分を捨てる前提に
   するかを決める
2. reset された stream で Object を 1 つも処理していない場合の開始位置を決める
3. reset の通知と続きの最初の Object は別の stream で届くため、到着順が保証されない。
   moqt-js はどちらの順でも扱えるようにするが、仕様としても到着順を前提にしないことを明記
   する
4. 回復の対象にする reset の error code を決める。MALFORMED_TRACK とセッション終了起源は
   回復しない。DELIVERY_TIMEOUT、INTERNAL_ERROR、CANCELLED などを対象にする
5. 「猶予不要」の意味を明確にする。reset の時点では開始は分かるが、終端は続きの最初の
   Object で決まる。続きがすぐ来る場合は範囲を確定してから fill / FETCH し、来ない場合だけ
   stall の猶予を置く、という区別にする
6. (1289 で決定済み) 続きの stream の Subgroup Header は、元の Subgroup ID を明示する。
   元の ID が 0 なら 0b00 か 0b10、それ以外は 0b10 にする。0b01 は使わない。FIRST_OBJECT
   ビットは落とし、Object ID Delta は自分の stream を基準に計算し直す

1289 の設計では、origin が SUBGROUP_HEADER の Subgroup ID モード 0b01 を最初の Object を
受けた時点で実際の値に置き換えてから配る。途中から開く stream では Subgroup ID を明示し、
FIRST_OBJECT ビットを落とす。sora-moq の `compute_subgroup_type_flags/5` は、整数の
Subgroup ID が 0 なら 0b00、原子の `first_object` なら 0b01、それ以外の整数なら 0b10 を
選ぶ。整数を渡す限り 0b01 にはならないため、EUnit では 0 と非 0 の 2 ケースを固定すれば
足りる。

moqt-js の受信側は 0b00 と 0b10 をそのまま解釈する。0b01 はストリームの最初の Object ID を
Subgroup ID にするため、続きでは使えない。FIRST_OBJECT を落とすのは、moqt-js が delivery
timeout の Object Property 上書きを「ストリーム先頭かつ FIRST_OBJECT」のときだけ適用する
ため、正しい。

### 4.5 sora-moq の確認結果のまとめ

- 購読中の fill: 現行版では使えない (REQUEST_UPDATE の fill が未実装)。実装予定であり、
  実装後は第一候補にする
- FETCH: 使える。cache、所有ノードの cache、publisher の 3 段。fill 実装後はフォールバック
- cache: 既定で有効。直近の Object は残る
- cluster の subgroup: reset 後に同じ (Group ID, Subgroup ID) の続きが別の stream で届く。
  猶予なしで検出できる
- cluster の datagram: 再送しない。クライアント側の fill / FETCH の主な対象
- last mile の datagram: relay の責務外。クライアント側の fill / FETCH の対象
- publisher の終了後: cache が破棄される。fill / FETCH の対象外

## 5. moqt-js の現状

### 5.1 使える API

- `Session.fetch(namespace, trackName, options, callbacks)` で FETCH を送れる。新しい bidi
  request stream を開き、FETCH_OK を待つ。`Fetcher` で `endLocation`、`endOfTrack`、
  `trackProperties`、`cancel()` を使える
- `FetchOptions.filter` は Location Filter を指定する。Type 0x02 (絶対開始)、0x03 (絶対開始と
  Group 終端)、0x04 (絶対範囲) を送れる。`{ nextObject: true }` と `{ reset: true }` もある
- `FetchOptions.fillTimeout` は FILL_TIMEOUT (0x0A) を送る。relay が上流の取得に使う合計時間
- `FetchOptions.groupOrder`、`subscriberPriority`、`rangeFilters`、`authorizationToken` も
  指定できる
- 購読側は `Subscriber.largestLocation` (LARGEST_OBJECT) と
  `Subscriber.largestReceivedLocation` (受信した最大 Location) を持つ
- `SubscribeCallbacks.subgroupEnd` は、Subgroup stream の FIN と RESET を
  `{ groupId, subgroupId?, reason, errorCode? }` で通知する。reset の検出に使える
- `MoqtObject` は `groupId`、`objectId`、`subgroupId`、`status`、`properties`、`payload` を持つ
- `ObjectStatus.END_OF_GROUP` / `END_OF_TRACK` を判定できる
- `Prior Group ID Gap` / `Prior Object ID Gap` は `properties.ts` で復号できる

### 5.2 既存の E2E で分かっていること

`tests/e2e/relay/fetch.spec.ts` は、sora-moq に対して絶対開始の Location Filter 付きの
FETCH が通り、FETCH_OK と Object が返ることを確認している。同じテストのコメントには、
フィルタを省略した FETCH と相対指定の FETCH は sora-moq が FETCH_OK を返さないため、
検証には絶対開始の 2 フィールドだけを使うと記録されている。ただし現在の sora-moq のコードは
`fetch_start_location/2` と `fetch_end_location/2` で省略時と相対指定も解決するため、この
記録は現在のコードに照らすと再確認が必要である。

Type 0x03 / 0x04 の範囲指定 FETCH は、moqt-js の E2E ではまだ確認していない。sora-moq の
コードは Type 0x03 / 0x04 を解決するため、実装上の障害は無い見込みである。実機での確認は
必要である。

### 5.3 不足している部品

- End of Range の通知: `src/session/stream.ts` の `processFetchObjects` は End of Range を
  アプリへ通知せずに読み飛ばす。コメントにも「アプリへのギャップの通知は仕様が求めていない
  ため行わない」とある。FETCH と fill の結果が unknown なのか timed out なのか非存在なのかを
  区別したい場合は、新しいコールバックか戻り値が要る
- FETCH 単位のギャップ一覧: `Fetcher` は取得した Object と End Location を返すが、要求範囲の
  うちどの Location が返らなかったかを直接は返さない。クライアントが要求範囲と受信 Location
  を突き合わせる必要がある
- 購読と FETCH の重複排除: 購読と FETCH は別のコールバックで Object を届ける。同じ Location
  が両方から届いた場合の重複排除はアプリの責務である
- 欠落の検出: moqt-js には「この購読でどの Location が欠けたか」を追跡する汎用の仕組みが
  無い。メディア経路は `VideoDecodeOrder` と playout で個別に扱っているが、汎用の
  欠落追跡ではない
- subgroup の reset と続きの追跡: `subgroupEnd` は (Group ID, Subgroup ID) と reset の
  error code を返すが、stream をまたいで最後に処理した Object ID を追跡する仕組みは無い。
  Controller が (Group ID, Subgroup ID) ごとに持つ必要がある
- 並べ替え: `PendingSubgroupBuffer` は Track Alias 未確立の stream を保持するためのもので、
  購読中の Object を Location 順に並べ替えるものではない
- FETCH の待ちとキャンセル: `Session.fetch()` が返す Promise は FETCH_OK まで解決しない。
  FETCH_OK が来ない場合、呼び出し側は `Fetcher` を受け取れないため `Fetcher.cancel()` も
  呼べない。呼び出し側で期限を設けるには、FETCH の Promise をタイムアウトで打ち切るか、
  FETCH_OK を待たずに `Fetcher` を返す API が要る
- fill の完了通知: `SubscribeCallbacks` には fill の正常終了 (FIN) を知らせるコールバックが
  無い。`fillError` は reset だけを通知する。fill の完了を待つには、新しいコールバックか
  Controller 側の期限が要る
- fill の Request ID と範囲: `MoqtObject.fillDelivered` は fill 経由かを示すが、どの fill
  要求の Object かは示さない。複数の fill を同時に開く場合は対応付けが要る。現行の
  sora-moq の初期 fill は購読あたり 1 本なので、Controller は 1 本ずつ直列化する
- fill の同時実行: 仕様は購読に複数の fill fetch stream を許す (§3.4) が、sora-moq の
  REQUEST_UPDATE の fill 実装が同時実行をどこまで許すかは、実装時に確認する

## 6. 欠落の検出

### 6.1 検出信号の優先順位

検出は「存在しない」と「欠落」と「未着」を分けることから始める。優先順位は次のとおり。

1. 存在しないことが権威づけられた範囲: Prior Group ID Gap、Prior Object ID Gap、
   END_OF_GROUP、END_OF_TRACK、FETCH の End of Non-Existent Range。取得しない
2. 欠落が権威づけられた範囲: Subgroup stream の reset と、同じ (Group ID, Subgroup ID) の
   続きの stream の最初の Object で確定する範囲。END_OF_GROUP の Object ID より小さいのに
   届いていない Object。MSF の Object ID の連続性に反する飛び。取得する。subgroup の
   reset は明示的な合図であり、猶予を置かない
3. 欠落の可能性が高い範囲: MSF の Group ID の連続性に反する飛び、datagram の飛び、
   LOC の TIMESTAMP の飛び。猶予時間の後に取得する
4. unknown の範囲: 最新 Group の中、まだ次の Group が来ていない範囲。すぐには取得しない。
   Largest Object を超える範囲は FETCH できないため、待つ

### 6.2 MSF のトラックでの連続性

MSF のトラックでは、次の連続性を検出の根拠にできる (`draft-ietf-moq-msf-01`)。

- Group ID は Track 内で一意で単調増加する (MUST)。継続した配信中は 1 ずつ増える (SHOULD)
- Object ID は Group の最初が 0 で、以降 1 ずつ増える (MUST、§6.2)
- publisher が再起動した場合、新しい開始 Group ID は以前より大きくする (MUST)。前の Group を
  知っていれば Prior Group ID Gap で知らせる (SHOULD)

したがって、MSF のトラックでは、音声の Group ID の飛びは「その Group の音声が欠けた」ことを
意味し、映像の Object ID の飛びは「そのフレームが欠けた」ことを意味する。ただし、Group ID の
飛びが publisher の再起動によるものか、経路の欠落によるものかは、飛びの大きさだけでは
決められない。Prior Group ID Gap があれば非存在として扱い、無ければ欠落候補として扱う。
再起動直後は開始 Group ID が大きく跳ぶため、飛びが大きい場合は欠落と決めつけない。

moqt-js のメディア publisher は MSF に従う。音声は 1 Object = 1 Group で、Group ID を
20 ms ごとに 1 進める。映像は Group の先頭がキーフレームで、Group 内の Object ID が連続する。
この前提は、moqt-js の publisher が送る Track では成り立つ。他の publisher が送る Track では
MSF への準拠を前提にできるが、保証ではない。汎用の仕組みにするなら、連続性の仮定は
オプトインにする。

### 6.3 subgroup の reset と続きの stream

subgroup の欠落は、ほかの検出信号と扱いが違う。reset と続きの stream の組が明示的な合図に
なるため、到着順の逆転を待つ猶予を置かない。

- 追跡のキーは (Group ID, Subgroup ID) である。stream 単位ではない
- reset を受けたら、その stream で最後に処理できた Object ID を記録する
- 同じキーの続きの stream の最初の Object を受けたら、最後に処理できた Object と最初の
  Object の間を欠落範囲にする
- 欠落範囲の開始は、最後に処理できた Object を含める形で指定する。RESET_STREAM_AT 非対応
  ではその Object が stream の最後とは限らないため、含めて FETCH し、重複を捨てる
- 続きの stream の最初の Object が、最後に処理できた Object 以下なら欠落は無い。重複か
  遅着として捨てる
- 続きの stream が来ないまま止まっている場合だけ、stall の猶予を置いて開いた範囲で FETCH
  する。範囲の終端が分からない場合は Type 0x02 か Type 0x03 を使う
- reset と続きの最初の Object は別の stream で届くため、到着順は保証されない。reset が
  先でも続きが先でも同じ結果になるようにする
- reset の error code が MALFORMED_TRACK の場合は購読が cancel されるため、回復しない。
  セッション終了起源の reset も回復しない
- Object ID は Group 内で共有される。欠落範囲に他の Subgroup の Object が含まれる場合は、
  FETCH の応答を Subgroup ID で選別するか、余分を捨てる。FETCH の応答が Subgroup ID を
  運ばない場合の扱いは 1288 / 1289 で決める
- reset された stream で Object を 1 つも処理していない場合、開始位置は Group の先頭
  (Object 0) か、続きの最初の Object から逆算する。どちらにするかは 1288 / 1289 で決める

### 6.4 検出の状態

購読ごとに、次の状態を持つ。

- 受信済みの Location の集合。直近の N Group 分だけ保持する。N は設定値とし、既定は 256 程度
- (Group ID, Subgroup ID) ごとの、最後に処理できた Object ID と、reset 後に続きを待って
  いるかどうかの印
- 欠落候補の範囲。Group の途中で欠けた Object の範囲、Group 全体が欠けた範囲、subgroup の
  reset で欠けた範囲
- 各候補の検出時刻。猶予時間と期限の基準にする
- 取得中の範囲。同じ範囲を二重に FETCH しない
- 取得済みの範囲。再試行を抑える
- 非存在が確定した範囲。Prior gap と END_OF_GROUP から作る

Group の完了は、END_OF_GROUP の Object を受信したとき、または次の Group の Object を受信して
猶予時間が経ったときにする。Group 内の Object の完了は、END_OF_GROUP の Object ID に達した
とき、または次の Group に進んだときにする。Subgroup の FIN は、その Subgroup の終わりを
示すが、Group 全体の終わりではない。複数の Subgroup がある Group では、FIN だけでは
Group の完了を決められない。

### 6.5 誤検出を避ける条件

- 到着順の逆転: Group をまたぐ Object は順不同で届く (§2.1)。欠落を検出した時点で
  FETCH を出すと、実は到着中の Object を二重に取る。subgroup の reset 以外は猶予時間を置き、
  FETCH で届いた Object は受信済みの Location と突き合わせて捨てる
- 同じ subgroup の別 stream: 先の stream が reset された場合、同じ (Group ID, Subgroup ID) の
  続きが別の stream で届く (§2.2)。これをプロトコル違反や重複と誤認しない。キーは
  (Group ID, Subgroup ID) で、stream ではない
- reset と続きの到着順: reset の通知と続きの最初の Object は別の stream で届くため、
  どちらが先に観測されるかは保証されない。どちらの順でも欠落範囲を確定できるようにする
- フィルタ: 購読に Location Filter や Range Filter がある場合、届かない Object は欠落では
  ない。フィルタ付きの購読では回復を無効にするか、フィルタを再適用する。メディア購読は
  フィルタ無しなので、この問題は無い
- 非存在: Prior gap と END_OF_GROUP を確認してから欠落と決める。存在しない Object を
  FETCH すると、FETCH は空の応答を返すか INVALID_RANGE になる
- publisher の再起動: Group ID が大きく跳ぶ。Prior Group ID Gap があれば非存在、無ければ
  「不明」として扱う。直近の連続した Group だけを回復対象にする
- 購読の開始位置: 購読を開始する前の Group は、そもそも購読の対象外である。最初に受信した
  Group より前は回復対象にしない
- paused: paused の購読では Object が届かない。paused 中の欠落検出は行わない。fill は
  paused の購読では開かれない (§3.4.1)。FETCH は送れるが、live の欠落回復の意味は薄い

### 6.6 猶予時間と期限

- 検出の猶予: subgroup の reset は明示的な合図なので 0。datagram は 20〜50 ms、Group の
  飛びや LOC の TIMESTAMP の飛びは 50〜100 ms を初期値にする。実測で調整する
- stall の猶予: subgroup の reset 後に続きの stream が来ない場合だけ、開始だけを決めて
  FETCH するまでの待ち。音声は 20〜50 ms、映像は 50〜100 ms を初期値にする
- 期限: 検出してから回復を諦めるまでの時間。メディアは再生時刻が期限になる。音声は
  目標遅延 (通常 100 ms 前後) から逆算し、FETCH の往復と復号の時間を引いた値にする。
  映像は次のキーフレームまでの時間を期限にする。汎用のデータはアプリが期限を決める
- 再試行: 期限までに 1〜2 回まで。FETCH_ERROR や空の応答で即座に再試行しない。
  backoff を置く。同じ範囲を何度も要求しない

## 7. fill / FETCH による回復の設計

### 7.1 配置

案は 3 つある。

| 案                                                                           | 内容                                                       | 評価                                                                                                          |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A: `SubscribeOptions` に回復設定を足し、`SubscriberImpl` の中で自動回復する  | 購読と一体で使いやすい                                     | 汎用の `Subscriber` にメディア向けの連続性仮定が入る。`handleFillObject` と同様のフィルタの問題を抱える。却下 |
| B: 独立した `GapRecoveryController` を作り、`Subscriber` と `Session` を渡す | オプトインで汎用。検出ポリシーを注入できる。テストしやすい | 採用する。低レベル API の利用者が明示的に使う                                                                 |
| C: `createMediaSubscriber` の中だけで回復する                                | メディアの期限と再生経路を直接扱える                       | まず B で基盤を作り、音声の実測が良ければ C に統合する                                                        |

B の Controller は、購読の Object コールバックを横取りするのではなく、購読とは別に
`Session.fetch` または `Subscriber.update({ fill })` を呼ぶ。アプリは購読の `object` /
`datagram` コールバックで受け取った Object を Controller へ渡し、Controller は受信 Location
の記録と回復要求の発行だけを行う。アプリは Controller から回復 Object を受け取る。購読の
コールバックの契約を変えないため、既存のアプリに組み込みやすい。

transport は fill と FETCH の 2 つを持つ。現行の sora-moq では FETCH を使い、fill の実装後は
fill を第一候補にする。fill は購読と同じ request stream を使い、`fillDelivered` 付きの
Object が購読の `object` コールバックに届く。FETCH は別の request stream を開き、`Fetcher`
のコールバックに届く。Controller はどちらの Object も同じ Location の記録と重複排除に通す。

### 7.2 API の形

```ts
interface GapRecoveryOptions {
  // 連続性の仮定。MSF のメディアトラックなら group: "contiguous", object: "contiguous"
  continuity: {
    group: "contiguous" | "none";
    object: "contiguous" | "none";
  };
  // 検出してから FETCH を出すまでの猶予 (ms)。subgroup の reset は 0 にする
  graceMs: number;
  // subgroup の reset 後に続きの stream が来ない場合の猶予 (ms)
  subgroupStallGraceMs: number;
  // 回復対象にする stream reset の error code
  recoverableResetCodes: DataStreamErrorCode[];
  // 検出してから諦めるまでの期限 (ms)。省略時はアプリが都度指定する
  deadlineMs?: number;
  // 回復要求の transport。"auto" は fill を試し、fill が来なければ FETCH に切り替える
  transport: "fill" | "fetch" | "auto";
  // fill 要求を送ってから fill fetch stream の最初の Object を待つ上限 (ms)
  fillWatchdogMs: number;
  // 直近何 Group までを回復対象にするか
  lookbackGroups: number;
  // FILL_TIMEOUT (ms)。0 は cache のみ
  fillTimeoutMs: number;
  // 同時に走らせる FETCH の数。初期値は 1
  maxInFlight: number;
  // 再試行の回数と間隔
  maxAttempts: number;
  retryBackoffMs: number;
}

interface RecoveredObject {
  object: MoqtObject;
  requestedRange: LocationRange;
  detectedAtMs: number;
  recoveredAtMs: number;
}

interface GapRecoveryController {
  // 購読とセッションに紐づける
  attach(subscriber: Subscriber, session: Session): void;
  // 回復 Object のコールバック。購読の object コールバックとは別に呼ぶ
  onRecovered?: (object: RecoveredObject) => void;
  onGiveUp?: (range: LocationRange, reason: GapGiveUpReason) => void;
  getStatistics(): GapRecoveryStatistics;
  close(): void;
}
```

API の名前と形は実装時に決める。重要なのは、回復を購読の自動動作にせず、オプトインに
することである。購読のフィルタ、アプリの期限、重複排除の可否はアプリごとに違う。

### 7.3 状態機械

```
idle
  -> detecting             欠落候補を検出し、猶予時間を待つ
  -> awaiting_continuation subgroup の reset 後、同じ (Group ID, Subgroup ID) の続きを待つ
  -> requesting            fill または FETCH を送る
  -> recovering            応答を待ち、Object を重複排除して渡す
  -> fallback              fill が来ない、または fill が失敗したので FETCH に切り替える
  -> done                  要求範囲が揃った
  -> retrying              一時的な失敗。backoff の後に requesting へ
  -> given_up              期限切れ、INVALID_RANGE、非存在、maxAttempts 超過
```

状態遷移の条件は次のとおり。

- `detecting` -> `requesting`: 猶予時間が経過し、欠落候補がまだ埋まっていない
- `detecting` -> `awaiting_continuation`: subgroup の reset を受けた。続きの最初の Object で
  欠落範囲の終端を決める。stall の猶予を過ぎたら `requesting` へ
- `awaiting_continuation` -> `requesting`: 同じ (Group ID, Subgroup ID) の続きの最初の
  Object を受けた、または stall の猶予が経過した
- `requesting` -> `recovering`: fill の `Subscriber.update({ fill })` が REQUEST_OK を返し、
  `fillDelivered` の最初の Object が届いた。または `session.fetch` が FETCH_OK を返した、
  または最初の Object が届いた
- `requesting` -> `fallback`: fill の `fillWatchdogMs` が過ぎても fill の Object が届かない。
  transport が `"auto"` のときだけ FETCH へ切り替える
- `fallback` -> `requesting`: FETCH を送る
- `recovering` -> `done`: 要求範囲の Location がすべて受信済みになった
- `recovering` -> `retrying`: `fillError`、FETCH_ERROR、stream reset、timeout
- `recovering` -> `fallback`: fill の失敗で、transport が `"auto"` のとき
- `recovering` -> `given_up`: 期限切れ、または取得しても Object が返らなかった
- 購読の `end` / `error`、セッションの close、GOAWAY で `given_up`。以後は何もしない

### 7.4 要求の粒度

欠落は次の 3 種類に分けて要求する。

1. Group 内の Object の範囲: Type 0x04 (絶対開始と絶対範囲) で、欠けた Object ID の範囲を
   指定する。終端の Object ID が分かっている場合に使う
2. Group 全体: Type 0x03 (絶対開始と Group 終端) で、欠けた Group を指定する。Group 内の
   Object ID の終端が分からない場合に使う。`endGroupDelta` は 0 とする
3. 複数 Group にまたがる範囲: Type 0x04 で開始 Group と終了 Group を指定する。連続した
   欠落 Group をまとめる。範囲が広すぎると回復要求の応答が大きくなるため、lookbackGroups と
   期限で切る
4. subgroup の reset: Type 0x04 で、reset された stream の最後に処理できた Object から、
   続きの stream の最初の Object の手前までを指定する。RESET_STREAM_AT 非対応では開始を
   最後に処理できた Object にし、重複を捨てる。続きが来ない場合は Type 0x02 か Type 0x03 を
   使う

Object ID は Group 内で共有されるため、subgroup の欠落範囲を取得すると、同じ Group の
他の Subgroup の Object が混ざる場合がある。fill / FETCH の応答は Subgroup ID で選別するか、
余分を捨てる。応答が Subgroup ID を運ばない場合の扱いは 1288 / 1289 で決める。

fill を使う場合も、範囲の指定は同じ Location Filter である。`Subscriber.update({ fill: {
filter: ... } })` で REQUEST_UPDATE に FILL_PARAMETERS を載せ、購読と同じ request stream から
fill fetch stream を開かせる。fill は購読の認可、優先度、フィルタを継承する。FETCH は
`Session.fetch` で新しい request stream を開く。fill が使えない場合と、購読とは独立に
取得したい場合に使う。

fill には REQUEST_ERROR が無く、正常終了は FIN、失敗は reset (`fillError`) で伝わる。
`SubscribeCallbacks` には fill の FIN を知らせるコールバックが無いため、Controller は要求
範囲の Object が揃うか、`fillError` か、独自の期限で完了を判断する。fetch の FETCH_OK と
同じ完了通知を fill にも用意するかは、moqt-js の API 追加として検討する。

Type 0x02 (絶対開始のみ) は終端が Largest Object になる。欠落の先頭から先の Object を
すべて取得することになり、重複が増える。範囲の終端が分からない場合の最後の手段にする。

FETCH の応答は要求範囲の Object をすべて含むとは限らない。cache に無く、上流も持たない
Object は gap になる。FETCH_OK の End Location と受信した Location を突き合わせ、欠けた
ままの Location は `given_up` にする。

### 7.5 重複排除

購読と fill / FETCH は別の経路で Object を届ける。同じ Location が両方から届くことがある。

- 購読で受信済みの Location を記録し、回復で届いた Object が同じ Location なら捨てる
- 回復で届いた Object をアプリへ渡した後、購読で同じ Location が届いたら捨てる
- 同じ Location の Object は、仕様上は同じバイト列でなければならない (§2.1)。バイト列が
  違う場合は Track の一貫性が壊れている。比較するかは実装コスト次第だが、少なくとも
  ログに残す

重複排除のキーは `groupId` と `objectId` の組である。Subgroup ID は dedup のキーには使わない。
FETCH の応答は Datagram の Object では Subgroup ID を運ばず、購読と FETCH で Delivery Mode が
異なり得るためである。

subgroup の reset の回復では、これとは別に、FETCH の応答の Object が要求した Subgroup の
ものかを Subgroup ID で確認する。Object ID の範囲には他の Subgroup の Object が混ざり得る
ためである。Subgroup ID が無い Object は、この選別ができない。1288 / 1289 で FETCH 応答の
Subgroup ID の扱いを決める。

### 7.6 配信と並べ替え

回復で届いた Object は、購読で届く Object より遅れて到着する。アプリが到着順に処理する
場合、回復した Object は「過去の Object」として届く。

- 汎用 API: 回復 Object に `recovered: true` のような印を付け、到着順で渡す。並べ替えは
  アプリの責務とする。ドキュメントに明記する
- メディアの音声: 復号器は投入順に復号するため、回復した古い Object を後から投入すると
  順序が崩れる。回復対象は「まだ復号へ投入していない次の Object」に限定するか、後続の
  Object を短い窓 (数十 ms) だけ保持して、回復を待ってから投入する。この保持は遅延を
  増やすため、実測で効果と遅延を比較する
- メディアの映像: `VideoDecodeOrder` は、Prior Object ID Gap で非存在が示されない限り、
  欠落の後の delta を捨ててキーフレームを待つ。回復がキーフレーム待ちより前に間に合う
  場合だけ効果がある。Group 全体の欠落は次のキーフレームで回復できるため、映像の
  回復対象は Group 内の Object の欠落に限定する。初期実装では映像を対象外にしてもよい

### 7.7 期限とメディアの再生

音声の再生は、到着した Object を復号し、playout の時間軸に載せる。回復した Object が
再生時刻を過ぎていれば、復号しても鳴らせない。したがって、回復の期限は「再生時刻」では
なく「復号へ投入できる時刻」で決める。

音声の目標遅延は 100 ms 前後である (docs/AUDIO_PLAYOUT_RESULT.md)。この遅延の中で、
欠落の検出 (subgroup の reset は 0、datagram は 20〜50 ms)、回復要求の往復 (edge の cache
なら 1 往復、所有ノードへ回るなら cluster の往復が加わる)、復号の準備が収まる必要がある。edge の cache に当たる場合は
現実的だが、所有ノードへ回る場合は厳しい。最初は edge の cache に当たる範囲だけを回復対象
にし、所有ノードへ回る場合は諦める、という段階的な設計が考えられる。

`MediaSubscriberOptions.preDecodeDelayMs` は復号前の保持であり、回復のための並べ替えでは
ない。回復と組み合わせる場合は、この保持の中に Location 順で挿入できるようにする必要が
ある。初期実装では preDecodeDelay に依存せず、回復の期限を短くする。

### 7.8 回復要求のオプション

fill と FETCH で共通の指定は `filter`、`fillTimeout`、`groupOrder`、`subscriberPriority` で
ある。

- `filter`: 上記の Type 0x03 / 0x04。Group 全体なら Type 0x03、Object の範囲なら Type 0x04
- `fillTimeout`: live の欠落は edge の cache に当たることを期待するなら 0。所有ノードや
  publisher からの取得を許すなら 100〜500 ms。0 は「cache に無ければ timed out の gap を
  返す」意味であり、上流の取得を待たない (§9.20.5)
- `authorizationToken`: 購読と同じトークンを付ける。メディアの Track は catalog の authInfo を
  持つ場合がある。購読に使ったトークンを保持して FETCH にも使う。fill は購読の認可を継承
  するため、FILL_PARAMETERS にトークンを載せない
- `groupOrder`: 回復範囲の取得順。通常は購読と同じ Ascending にする
- `rangeFilters`: 使わない。回復範囲は Location で指定する

fill の場合、`Subscriber.update({ fill })` の Promise は REQUEST_OK までで、fill fetch stream
の完了は待たない。fill の Object は購読の `object` コールバックに `fillDelivered: true` で
届く。完了は要求範囲が揃うか、`fillError`、独自の期限で判断する。fill の Object が
`fillWatchdogMs` の間に届かなければ、実装されていないか失敗したとみなし、transport が
`"auto"` なら FETCH に切り替える。

FETCH の場合、`Session.fetch()` の Promise は FETCH_OK まで解決しない。FETCH_OK が来る前に
データストリームが先着した場合、受信側は FETCH_OK を最大 5 秒待ってから処理する。cache から
応答する場合は FETCH_OK が早い。所有ノードや publisher へ回る場合は遅れることがある。
呼び出し側も FETCH_OK の待ちに独自の期限を設け、期限を過ぎたら回復を諦める。`fillTimeout`
を期限より小さくして、relay が早く gap を返すようにする。

### 7.9 観測

- 検出した欠落の数と種類 (Group / Object / Subgroup reset / datagram)
- fill を要求した回数と範囲の大きさ、fill が来なかった回数、FETCH にフォールバックした回数
- FETCH を出した回数と範囲の大きさ
- 回復できた Object の数
- 回復までの時間 (検出から Object の到着まで)
- 諦めた回数と理由 (期限、INVALID_RANGE、cache miss、上流の失敗、session 終了)
- 重複として捨てた数
- FETCH の応答で返らなかった Location の数
- FETCH のバイト数

`SessionStatistics` の `objectsReceivedViaFetch` / `bytesReceivedViaFetch` は既にある。
Controller の統計は別に持つ。

## 8. 失敗モードと限界

| 失敗                                | 症状                           | 回復                                                    | 備考                                  |
| ----------------------------------- | ------------------------------ | ------------------------------------------------------- | ------------------------------------- |
| edge の cache に無い                | FETCH が上流へ回る             | 所有ノードの cache か publisher から取れる              | cluster の cross-node FETCH           |
| 所有ノードの cache にも無い         | FETCH が publisher へ回る      | publisher が保持していれば取れる                        | publisher の保持はアプリ次第          |
| publisher が終了                    | cache が破棄される             | 取れない                                                | 配信側の障害であり、対象外            |
| cache から evict                    | FETCH が空になる               | 取れない                                                | 古い範囲。期限を短くする              |
| FETCH の開始位置が Largest を超える | INVALID_RANGE                  | Largest が進むまで待つ                                  | live の先頭。購読で受ける             |
| FETCH_OK が遅い                     | `Session.fetch()` が解決しない | 独自の期限で打ち切り、再試行                            | データストリームは 5 秒で処理を諦める |
| FETCH の応答に End of Range がある  | moqt-js が読み飛ばす           | 欠落のまま                                              | 8.1 の制限                            |
| 購読が paused                       | Object が届かない              | fill は開かれない。FETCH は送れるが live の回復ではない | paused 中は検出しない                 |
| PUBLISH_DONE                        | 購読が終わる                   | 過去 Object は FETCH できる場合がある                   | cache が残っている間だけ              |
| GOAWAY / セッション断               | FETCH を送れない               | 再接続か移行                                            | この仕組みの対象外                    |
| malformed track                     | 購読が cancel される           | 取れない                                                | §12.1                                 |
| フィルタ付き購読                    | 届かない Object がある         | フィルタを再適用するか回復しない                        | メディア購読はフィルタ無し            |
| 順序の逆転                          | 回復 Object が遅れて届く       | 並べ替える                                              | 8.2                                   |
| subgroup の続きが来ない             | 欠落範囲の終端が不明           | stall の猶予後に開いた範囲で FETCH                      | 6.3                                   |
| reset と続きの到着順が逆            | 検出の順序が不定               | どちらの順でも確定できるようにする                      | 6.3 / 6.5                             |
| FETCH 応答に他の Subgroup の Object | 余分が混ざる                   | Subgroup ID で選別し、余分を捨てる                      | 7.4 / 7.5                             |
| RESET_STREAM_AT 非対応              | 最後の Object が不明           | 最後に処理した Object から FETCH、重複排除              | 4.4                                   |
| reset された stream で Object 0 件  | 開始位置が不明                 | 1288 / 1289 の規定待ち                                  | 4.4.1                                 |
| fill が未実装                       | fill stream が来ない           | watchdog の後に FETCH にフォールバック                  | 現行版。実装予定                      |
| fill の失敗                         | fillError / stream reset       | FETCH にフォールバック、または再試行                    | fill は購読を止めない                 |
| fill の完了通知が無い               | 完了が分からない               | 要求範囲の受領と期限で判断                              | API 追加を検討                        |
| ペイロードの改変                    | バイト列が違う                 | 検出できない                                            | end-to-end 保護 (§15.4)               |

### 8.1 End of Range を読めない制限

moqt-js は FETCH と fill の End of Range をアプリへ通知しない。したがって、FETCH / fill で
返らなかった Location が「存在しない」「unknown」「timed out」のどれなのかを区別できない。
回復の初期実装では、次のように扱う。

- FETCH / fill が正常に終わり、要求範囲の Location が返らなかった場合、その範囲は回復
  できないとみなして諦める
- 再試行は 1 回までにする。timed out を unknown と誤認して何度も取りに行くのを避ける
- 正確な区別が必要になったら、End of Range を通知するコールバックを moqt-js に足す。
  これは `SubscribeCallbacks` と `FetchCallbacks` の両方に関わる API 変更になる

### 8.2 順序と再生の限界

fill / FETCH は欠落を埋めるが、到着順は直せない。音声の復号器と playout は投入順と
timestamp に依存するため、回復が遅れると効果が無い。回復の価値は「再生の期限までに間に合う
か」で決まる。この期限はアプリとメディアの構成で変わるため、実装後に実測して判断する。

### 8.3 ペイロードの真正性

fill / FETCH は Object を取得する手段であり、内容の真正性を検証する手段ではない。relay が
異なるバイト列を返した場合、クライアントは仕様違反を検出できるが、正しい内容を復元
できない。end-to-end の暗号化や署名 (Secure Objects など) が別途必要である (§15.4)。

### 8.4 sora-moq 1289 の reset / 継続 stream と競合する範囲

subgroup の reset は 1289 の合図で検出する。cluster の内部修復の期限を待たず、reset と
続きの stream の最初の Object で欠落範囲を決めて回復要求を出す。reset の通知と続きの
最初の Object は別の stream で届くため、どちらが先に観測されても同じ結果になるようにする。

datagram は明示的な reset の合図が無いため、Group ID / Object ID の飛びから猶予を置いて
検出する。cluster の内部修復に任せず、クライアント側で検出してよい。

## 9. 実装計画

### 9.1 段階

| 段階 | 内容                       | 完了条件                                                                                                            |
| ---- | -------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 0    | 実リレーでの FETCH の確認  | 購読中に Type 0x03 / 0x04 の FETCH を送り、cache から Object が返ることを E2E で確認する                            |
| 1    | 検出と FETCH の Controller | 購読の Location を記録し、欠落を検出し、FETCH を出し、重複を排除して回復 Object を渡す。単体テストと PBT で固定する |
| 2    | fill transport の追加      | sora-moq の fill 実装後、REQUEST_UPDATE の fill を第一候補にし、fill の watchdog と fillError で FETCH に切り替える |
| 3    | 音声への統合               | 音声の欠落を検出し、再生の期限までに回復できた場合だけ復号へ渡す。実リレーで欠落を注入して効果を測る                |
| 4    | 観測と調整                 | 検出、回復、失敗、遅延の統計を公開し、猶予時間、期限、fillTimeout を実測で調整する                                  |

### 9.2 テスト

- 単体テスト: 検出の状態機械、Group / Object の連続性、Prior gap による非存在の除外、
  END_OF_GROUP による完了、subgroup の reset と続きの stream、reset と続きの到着順の
  入れ替え、RESET_STREAM_AT 非対応時の開始位置、他の Subgroup の Object の選別、stall の
  猶予、猶予時間、期限、重複排除、範囲のまとめ方、再試行、諦め、fill の watchdog と
  FETCH へのフォールバック、fillError の扱い
- PBT: 任意の Location 列と reset / 継続の列に対して、欠落の検出と範囲のまとめ方が単調で
  あること、同じ Location を二重に要求しないこと、受信済みの Location を回復対象にしない
  こと、reset と続きの順序を入れ替えても結果が変わらないこと、fill と FETCH のどちらでも
  同じ欠落範囲になること
- 結合テスト: `Session` と `Subscriber` を実ストリームで動かし、FETCH の応答と fill の
  Object を注入して重複排除と期限を確認する。モックやスタブは使わない (AGENTS.md)
- E2E: sora-moq に対して、購読中に欠落範囲の FETCH を送り、cache から Object が返ること、
  購読が継続すること、FETCH の前後で Object の重複が起きないことを確認する。fill の
  REQUEST_UPDATE 経路と subgroup の reset / 続きの stream は、sora-moq の実装後に実リレーで
  確認する
- 欠落の注入: datagram の欠落を実リレーで作るのは難しい。ブラウザ側で受信 datagram を
  捨てる経路を作るか、unit / 結合テストで代替する。E2E では「過去の範囲を FETCH で取れる」
  ことと「購読に影響しない」ことを確認する

### 9.3 完了条件

- 購読を維持したまま、欠落範囲の fill / FETCH が動く
- fill が来ない、または fill が失敗した場合に FETCH にフォールバックする
- 購読の Object と fill / FETCH の Object の重複が排除される
- 期限を過ぎた回復が復号や再生を壊さない
- 購読の終了、セッションの終了、GOAWAY で回復が止まる
- 統計で検出、回復、失敗、遅延が分かる
- `vp check` / `tsc --noEmit` / `vp test run` が通る

## 10. やらないこと

- 現行版の sora-moq で REQUEST_UPDATE + FILL_PARAMETERS による fill fetch を使うこと。
  fill の実装までは FETCH で動かし、実装後は fill を第一候補にする
- fill fetch stream の実装そのもの。sora-moq 側の作業であり、クライアント側の Controller は
  fill と FETCH の両方を扱う
- subgroup の reset 後に同じ (Group ID, Subgroup ID) の続きが別の stream で届くことを
  プロトコル違反として扱うこと。draft-22 §2.2 が許す動きである
- cluster の graft / link_resume の 5 秒の修復期限を前提にすること。sora-moq 1289 の
  reset / 継続 stream の合図を使う
- 順序の修復。FETCH は欠落を埋めるだけで、並べ替えは受信側の責務である
- ペイロードの真正性の検証。end-to-end 保護の担当である
- publisher が終了した Track の回復。cache が破棄されるため対象外である
- セッション断と GOAWAY の回復。再接続か移行の担当である

## 11. 参照

### 仕様

- draft-ietf-moq-transport-22 §1.4 (RESET_STREAM_AT)、§2.1 (Object の不変性)、
  §2.1.2 (Object の状態)、§2.2 (Subgroup)、§2.3.1 (Group の欠落と Fetch upstream)、
  §2.5 (scope)
- §3.1 (Subscription と Fetch)、§3.1.4 (Largest Object)、§3.2 (Fetch)、
  §3.2.1 (Fetch の順序)、§3.2.2 (Fetch の gap)、§3.2.3 (Relay の Fetch)、
  §3.2.4 (Fetch state)
- §3.3.1 (Location Filter)、§3.4 (Fill Semantics)、§3.4.1 (Fill fetch stream)、
  §3.5 (Join)
- §5.1.2 (fill-delivered の優先)、§5.2 (delivery timeout)
- §6.4.2.1 (Request ID)、§6.4.2.2 (request stream の閉じ方)
- §7.1 (cache)、§7.3 (複数 publisher)、§7.4 (並べ替えと欠落の禁止)、§7.6 (fill の処理)、
  §7.8 (payload の不変)
- §9.5 / §9.5.1 (REQUEST_UPDATE)、§9.11 (FETCH)、§9.12 (FETCH_OK)
- §9.20.5 (FILL_TIMEOUT)、§9.20.9 (LOCATION FILTER)、§9.20.15 (FILL_PARAMETERS)
- §10.3 (MAX_CACHE_DURATION)、§10.8 (Prior Group ID Gap)、§10.9 (Prior Object ID Gap)
- §11.1.1 (Object Status)、§11.3.1 (Subgroup Header)、§11.3.2 (Closing Subgroup Streams)、
  §11.4.1.2 (End of Range)
- §12.1 (Malformed Track)、§12.5 (stream reset code)、§15.4 (Media Security)

### MSF

- draft-ietf-moq-msf-01 §6.1 (Group numbering)、§6.2 (Object numbering)

### コード

- moqt-js: `src/session.ts` の `fetch`、`src/fetcher.ts` の `Fetcher`、
  `src/session/publicTypes.ts` の `FetchOptions` / `FetchCallbacks`、
  `src/session/stream.ts` の `processFetchObjects`、
  `src/subscriber.ts` の `largestLocation` / `largestReceivedLocation`、
  `src/session/dataStreamIncoming.ts` の Subgroup の reset と fill fetch stream、
  `src/videoDecodeOrder.ts` の欠落判定、`src/playout/*` の再生
- sora-moq: `src/sora_moq_relay.erl` の `subscribe_fill_request/1`、
  `maybe_start_fill_stream/6`、`handle_downstream_request_update/4`、
  `apply_downstream_update/4`、`cache_fetch_response/5`、`forward_fetch_upstream/7`、
  `cache_store_datagram/4`、`fetch_fill_timeout/1`、`check_fetch_range/4`
- sora-moq: `src/moqt/moqt_subscription.erl` の `fetch_start_location/2`、
  `fetch_end_location/2`、`fill_range_from_fill_parameters/3`
- sora-moq: `src/moqt/moqt_object.erl` の `compute_subgroup_type_flags/5`、
  `encode_subgroup_header/1`
- sora-moq: `src/sora_moq_plumtree.erl` の欠番検出と `graft` / `link_resume`、
  `src/sora_moq_cluster_replica.erl` の `?DEFAULT_GAP_TIMEOUT_MS`、
  `src/sora_moq_cluster_origin.erl` の `broadcast_datagram/2`
- sora-moq: `docs/moqt_relay.md` の「未実装の範囲」、`docs/cluster.md` の「cache」と
  「2 段構成の実装」、`docs/conf.md` の cache 設定
- sora-moq: 1288 / 1289 (subgroup stream の reset 後の継続 stream と gap 検出の仕様)
- sora-moq: REQUEST_UPDATE + FILL_PARAMETERS の fill fetch stream (実装予定)

### 関連 issue

- `issues/0817-add-relay-tests.md`: 実リレーを使った E2E の追加。fill の検証もここで行う
- `issues/0865-change-catalog-fill-fetch.md`: catalog の fill 化。実リレーの fill 対応を
  確認する
- `issues/0864-add-publisher-prior-group-id-gap.md`: Prior Group ID Gap の送信側
- `issues/0835-bug-catalog-fetch-cancel.md` / `issues/0836-bug-catalog-drain-error-handling.md`:
  catalog の FETCH の状態管理
