import { test, assert } from "vite-plus/test";
import { AuthorizationTokenAliasType } from "moqt-js";
import {
  applyC4mFromUrl,
  authorizationTokenAlias,
  authorizationTokenAliasType,
  authorizationTokenBase64,
  authorizationTokenType,
  authorizationTokenValue,
  buildAuthorizationToken,
  buildQueryString,
  buildQueryStringForMode,
  catalogSubscriptionTimeout,
  CATALOG_SUBSCRIPTION_TIMEOUTS,
  initFromUrl,
  isAudioSourceType,
  isVideoSourceType,
  jitterBufferEnabled,
  mode,
  audioAutoGainControl,
  audioEchoCancellation,
  audioNoiseSuppression,
  audioSource,
  selectedMicrophoneDeviceId,
  url,
  useDedicatedWorker,
  videoSource,
} from "./connectionSettings";

// テスト間で Authorization Token の signal を持ち越さないためのリセット
function resetAuthorizationTokenSettings(): void {
  authorizationTokenAliasType.value = "useValue";
  authorizationTokenAlias.value = "0";
  authorizationTokenType.value = "0";
  authorizationTokenValue.value = "";
  authorizationTokenBase64.value = "";
}

// バイト列を Base64 文字列に変換する (C4M トークンの入力を作る)
function toBase64(bytes: number[]): string {
  return btoa(String.fromCharCode(...bytes));
}

// MSF URL の c4m を読み込むと、Token Value をクリアして Base64 トークンと
// USE_VALUE / Token Type 0x01 (CAT, draft-ietf-moq-c4m-01 §7.1 Table 4) が設定される。
test("applyC4mFromUrl: c4m から Base64 トークンと USE_VALUE / Token Type 0x01 を反映する", () => {
  resetAuthorizationTokenSettings();
  authorizationTokenValue.value = "manual-token";

  const applied = applyC4mFromUrl("moqt://example.com/moqt#msf:room-123--catalog&c4m=QUFB");

  assert.equal(applied, true);
  assert.equal(authorizationTokenBase64.value, "QUFB");
  assert.equal(authorizationTokenValue.value, "");
  assert.equal(authorizationTokenAliasType.value, "useValue");
  assert.equal(authorizationTokenType.value, "1");
});

// URI Fragment 欄への貼り付けを想定し、fragment 単体でも c4m を読み込める。
test("applyC4mFromUrl: msf fragment 単体から c4m を読み込む", () => {
  resetAuthorizationTokenSettings();

  const applied = applyC4mFromUrl("msf:room-123--catalog&c4m=QUFB");

  assert.equal(applied, true);
  assert.equal(authorizationTokenBase64.value, "QUFB");
});

// c4m が無い URL では false を返し、設定済みの Authorization Token を変更しない。
test("applyC4mFromUrl: c4m が無い場合は false を返し設定を変更しない", () => {
  resetAuthorizationTokenSettings();
  authorizationTokenValue.value = "manual-token";

  const applied = applyC4mFromUrl("moqt://example.com/moqt#msf:room-123--catalog");

  assert.equal(applied, false);
  assert.equal(authorizationTokenBase64.value, "");
  assert.equal(authorizationTokenValue.value, "manual-token");
});

// 不正な Base64 の c4m は反映せず、false を返す。
test("applyC4mFromUrl: 不正な Base64 の c4m は反映しない", () => {
  resetAuthorizationTokenSettings();

  const applied = applyC4mFromUrl("msf:room-123--catalog&c4m=not base64!!");

  assert.equal(applied, false);
  assert.equal(authorizationTokenBase64.value, "");
});

// c4m から読み込んだトークンは Base64 を復号した生バイト列として、Token Type 0x01 (CAT) で
// SETUP に載る (draft-ietf-moq-c4m-01 §7.1 Table 4 / §7.1.1)。
test("buildAuthorizationToken: c4m の Base64 トークンを CAT (Token Type 0x01) として復号する", () => {
  resetAuthorizationTokenSettings();
  const bytes = [0x83, 0x68, 0x61, 0x00, 0xff];
  applyC4mFromUrl(`moqt://example.com/moqt#msf:room-123--catalog&c4m=${toBase64(bytes)}`);

  const token = buildAuthorizationToken();
  assert.equal(token?.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (token?.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.equal(token.tokenType, 1n);
    assert.deepEqual(token.tokenValue, new Uint8Array(bytes));
  }
});

// Token Type が空文字のときは 0n になる (手入力で空にした場合のフォールバック)。
test("buildAuthorizationToken: Token Type が空文字のときは 0n になる", () => {
  resetAuthorizationTokenSettings();
  authorizationTokenValue.value = "manual-token";
  authorizationTokenType.value = "";

  const token = buildAuthorizationToken();
  assert.equal(token?.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (token?.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.equal(token.tokenType, 0n);
  }
});

// 手書きの共有 URL を想定し、c4m を持つ url パラメータと Authorization Token の
// クエリパラメータを同時に持つ検索文字列では c4m を優先する。
test("initFromUrl: c4m を持つ URL はクエリの Token Type / Token Value より優先する", () => {
  resetAuthorizationTokenSettings();
  const c4mBase64 = toBase64([0x01, 0x02, 0x03]);
  const params = new URLSearchParams();
  params.set("url", `moqt://example.com/moqt#msf:room-123--catalog&c4m=${c4mBase64}`);
  params.set("authorizationTokenType", "0");
  params.set("authorizationTokenValue", "manual-token");

  initFromUrl(params.toString());

  // c4m の取り込みで Token Type は 0x01 (CAT)、Token Value は取り込んだトークンになる
  assert.equal(authorizationTokenType.value, "1");
  assert.equal(authorizationTokenValue.value, "");
  const token = buildAuthorizationToken();
  assert.equal(token?.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (token?.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.equal(token.tokenType, 1n);
    assert.deepEqual(token.tokenValue, new Uint8Array([0x01, 0x02, 0x03]));
  }
});

// fragment の c4m は url の c4m より優先する。
test("initFromUrl: fragment の c4m を url の c4m より優先する", () => {
  resetAuthorizationTokenSettings();
  const urlC4m = toBase64([0x0a]);
  const fragmentC4m = toBase64([0x0b]);
  const params = new URLSearchParams();
  params.set("url", `moqt://example.com/moqt#msf:room-123--catalog&c4m=${urlC4m}`);
  params.set("fragment", `msf:room-123--catalog&c4m=${fragmentC4m}`);

  initFromUrl(params.toString());

  assert.equal(authorizationTokenBase64.value, fragmentC4m);
  assert.equal(authorizationTokenType.value, "1");
});

// fragment に c4m が無い場合でも url の c4m を取り込む (develop からの回帰の固定)。
test("initFromUrl: fragment に c4m が無くても url の c4m を取り込む", () => {
  resetAuthorizationTokenSettings();
  const c4mBase64 = toBase64([0x01, 0x02]);
  const params = new URLSearchParams();
  params.set("url", `moqt://example.com/moqt#msf:room-123--catalog&c4m=${c4mBase64}`);
  // c4m を含まない fragment (Copy URL が url と fragment を同時に書き出す形)
  params.set("fragment", "msf:room-123--catalog--track:video");

  initFromUrl(params.toString());

  assert.equal(authorizationTokenBase64.value, c4mBase64);
  assert.equal(authorizationTokenType.value, "1");
  const token = buildAuthorizationToken();
  if (token?.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.equal(token.tokenType, 1n);
    assert.deepEqual(token.tokenValue, new Uint8Array([0x01, 0x02]));
  }
});

// fragment の c4m が不正な場合は url の c4m を使う (不正な値で取り込みを壊さない)。
test("initFromUrl: fragment の c4m が不正な場合は url の c4m を使う", () => {
  resetAuthorizationTokenSettings();
  const urlC4m = toBase64([0x01, 0x02]);
  const params = new URLSearchParams();
  params.set("url", `moqt://example.com/moqt#msf:room-123--catalog&c4m=${urlC4m}`);
  params.set("fragment", "msf:room-123--catalog--track:video&c4m=not base64!!");

  initFromUrl(params.toString());

  assert.equal(authorizationTokenBase64.value, urlC4m);
  assert.equal(authorizationTokenType.value, "1");
});

// c4m が無い検索文字列ではクエリの Authorization Token 設定をそのまま適用する。
test("initFromUrl: c4m が無い場合はクエリの Token Type / Token Value を適用する", () => {
  resetAuthorizationTokenSettings();
  const params = new URLSearchParams();
  params.set("url", "moqt://example.com/moqt");
  params.set("authorizationTokenType", "2");
  params.set("authorizationTokenValue", "manual-token");

  initFromUrl(params.toString());

  assert.equal(authorizationTokenType.value, "2");
  assert.equal(authorizationTokenValue.value, "manual-token");
  assert.equal(authorizationTokenBase64.value, "");
});

// Base64 トークンが無い場合は従来どおり Token Value を UTF-8 として送る。
test("buildAuthorizationToken: Base64 トークンが無い場合は Token Value を UTF-8 として使う", () => {
  resetAuthorizationTokenSettings();
  authorizationTokenValue.value = "manual-token";

  const token = buildAuthorizationToken();
  assert.equal(token?.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (token?.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.deepEqual(token.tokenValue, new TextEncoder().encode("manual-token"));
  }
});

// c4m 読み込み後に Token Value が残っていても、Base64 トークンを優先する。
test("buildAuthorizationToken: Base64 トークンを Token Value より優先する", () => {
  resetAuthorizationTokenSettings();
  authorizationTokenBase64.value = toBase64([0x01, 0x02]);
  authorizationTokenValue.value = "manual-token";

  const token = buildAuthorizationToken();
  assert.equal(token?.aliasType, AuthorizationTokenAliasType.USE_VALUE);
  if (token?.aliasType === AuthorizationTokenAliasType.USE_VALUE) {
    assert.deepEqual(token.tokenValue, new Uint8Array([0x01, 0x02]));
  }
});

// REGISTER / Token Alias を選択した場合は c4m のバイト列をそのまま使い、Alias 設定を尊重する。
test("buildAuthorizationToken: REGISTER の設定でも c4m のバイト列を使う", () => {
  resetAuthorizationTokenSettings();
  authorizationTokenBase64.value = toBase64([0x10, 0x20]);
  authorizationTokenAliasType.value = "register";
  authorizationTokenAlias.value = "7";

  const token = buildAuthorizationToken();
  assert.equal(token?.aliasType, AuthorizationTokenAliasType.REGISTER);
  if (token?.aliasType === AuthorizationTokenAliasType.REGISTER) {
    assert.equal(token.tokenAlias, 7n);
    assert.deepEqual(token.tokenValue, new Uint8Array([0x10, 0x20]));
  }
});

// 購読した映像を LOC TIMESTAMP (壁時計) の間隔どおりに表示する jitter buffer は既定で
// 有効にする。無効にすると従来どおり届いたタイミングのまま表示する
test("jitterBufferEnabled: 既定は有効", () => {
  assert.isTrue(jitterBufferEnabled.value);
});

// URL の jitterBuffer=0 で無効、jitterBuffer=1 で有効にする。それ以外の値は無視する
test("initFromUrl: jitterBuffer で jitter buffer の有効・無効を反映する", () => {
  jitterBufferEnabled.value = true;
  initFromUrl("jitterBuffer=0");
  assert.isFalse(jitterBufferEnabled.value);
  initFromUrl("jitterBuffer=yes");
  assert.isFalse(jitterBufferEnabled.value);
  initFromUrl("jitterBuffer=1");
  assert.isTrue(jitterBufferEnabled.value);
});

// Copy URL が作る URL は無効のときだけ jitterBuffer=0 を載せ (既定の有効は載せない)、
// その URL から設定を復元できる
test("buildQueryString: jitter buffer を無効にした設定を URL で往復できる", () => {
  jitterBufferEnabled.value = true;
  assert.isNull(new URLSearchParams(buildQueryString()).get("jitterBuffer"));

  jitterBufferEnabled.value = false;
  const query = buildQueryString();
  assert.equal(new URLSearchParams(query).get("jitterBuffer"), "0");

  jitterBufferEnabled.value = true;
  initFromUrl(query);
  assert.isFalse(jitterBufferEnabled.value);
  jitterBufferEnabled.value = true;
});

// 音声の入力にマイクを選べる。URL の audioSource=microphone も受理する
test("isAudioSourceType: microphone を音声の入力として受理する", () => {
  assert.isTrue(isAudioSourceType("microphone"));
  assert.isFalse(isAudioSourceType("line-in"));
  audioSource.value = "none";
  initFromUrl("audioSource=microphone");
  assert.equal(audioSource.value, "microphone");
  audioSource.value = "none";
});

// 映像の入力に None (映像を送らず音声だけを配信する) を選べる。URL の videoSource=none も
// 受理し、Copy URL で往復できる
test("isVideoSourceType: none を映像の入力として受理し、URL で往復できる", () => {
  assert.isTrue(isVideoSourceType("none"));
  assert.isTrue(isVideoSourceType("dummy"));
  assert.isTrue(isVideoSourceType("camera"));
  assert.isFalse(isVideoSourceType("screen"));

  videoSource.value = "none";
  const query = buildQueryString();
  assert.equal(new URLSearchParams(query).get("videoSource"), "none");
  videoSource.value = "dummy";
  initFromUrl(query);
  assert.equal(videoSource.value, "none");

  // 選択肢に無い値は受理せず、今の設定のまま残す
  initFromUrl("videoSource=screen");
  assert.equal(videoSource.value, "none");
  videoSource.value = "dummy";
});

// 音声処理 (エコー除去 / ノイズ抑制 / 自動ゲイン) の既定はブラウザの既定と同じ有効
test("音声処理の切り替え: 既定は有効", () => {
  assert.isTrue(audioEchoCancellation.value);
  assert.isTrue(audioNoiseSuppression.value);
  assert.isTrue(audioAutoGainControl.value);
});

// Copy URL は無効にした音声処理だけを =0 で載せ、その URL から設定を復元できる。
// 選んだマイクのデバイスも載せる (カメラの cameraDeviceId と同じ)
test("buildQueryString: マイクのデバイスと音声処理を URL で往復できる", () => {
  selectedMicrophoneDeviceId.value = "mic-1";
  audioEchoCancellation.value = false;
  audioNoiseSuppression.value = true;
  audioAutoGainControl.value = false;
  const params = new URLSearchParams(buildQueryString());
  assert.equal(params.get("microphoneDeviceId"), "mic-1");
  assert.equal(params.get("audioEchoCancellation"), "0");
  assert.isNull(params.get("audioNoiseSuppression"));
  assert.equal(params.get("audioAutoGainControl"), "0");

  selectedMicrophoneDeviceId.value = "";
  audioEchoCancellation.value = true;
  audioAutoGainControl.value = true;
  initFromUrl(params.toString());
  assert.equal(selectedMicrophoneDeviceId.value, "mic-1");
  assert.isFalse(audioEchoCancellation.value);
  assert.isTrue(audioNoiseSuppression.value);
  assert.isFalse(audioAutoGainControl.value);

  selectedMicrophoneDeviceId.value = "";
  audioEchoCancellation.value = true;
  audioAutoGainControl.value = true;
});

// URL の mode で表示モードを決める。both は既定のため Copy URL に載せず、publisher /
// subscriber のときだけ載せて開き直しても同じモードで表示できる
test("initFromUrl / buildQueryString: mode を URL で往復できる", () => {
  mode.value = "both";
  assert.isNull(new URLSearchParams(buildQueryString()).get("mode"));

  initFromUrl("mode=publisher");
  assert.equal(mode.value, "publisher");
  const publisherQuery = buildQueryString();
  assert.equal(new URLSearchParams(publisherQuery).get("mode"), "publisher");

  // 開き直しても publisher のままになる
  mode.value = "both";
  initFromUrl(publisherQuery);
  assert.equal(mode.value, "publisher");

  initFromUrl("mode=subscriber");
  assert.equal(mode.value, "subscriber");
  assert.equal(new URLSearchParams(buildQueryString()).get("mode"), "subscriber");

  mode.value = "both";
});

// 許可リストに無い mode は無視し、両方を表示する both のままにする
test("initFromUrl: 許可リストに無い mode は無視する", () => {
  mode.value = "both";
  initFromUrl("mode=foo");
  assert.equal(mode.value, "both");
});

// mode の無い URL では both (両方の表示) のままにする。許可リストにある both は
// 明示的に指定しても受理し、publisher から both へ戻せる
test("initFromUrl: mode が無い URL と mode=both は both にする", () => {
  mode.value = "both";
  initFromUrl("url=moqt%3A%2F%2Fexample.com");
  assert.equal(mode.value, "both");

  mode.value = "publisher";
  initFromUrl("mode=both");
  assert.equal(mode.value, "both");
});

// 副題のリンク用のクエリは、今の接続設定を保ったまま mode だけを差し替える。
// both のリンクでは mode を載せない
test("buildQueryStringForMode: 今の設定を保ったまま mode だけを差し替える", () => {
  mode.value = "both";
  url.value = "moqt://example.com/moqt";
  try {
    const publisherQuery = new URLSearchParams(buildQueryStringForMode("publisher"));
    assert.equal(publisherQuery.get("mode"), "publisher");
    assert.equal(publisherQuery.get("url"), "moqt://example.com/moqt");

    const subscriberQuery = new URLSearchParams(buildQueryStringForMode("subscriber"));
    assert.equal(subscriberQuery.get("mode"), "subscriber");
    assert.equal(subscriberQuery.get("url"), "moqt://example.com/moqt");

    const bothQuery = new URLSearchParams(buildQueryStringForMode("both"));
    assert.isNull(bothQuery.get("mode"));
    assert.equal(bothQuery.get("url"), "moqt://example.com/moqt");

    // 今のモードの signal は変えない
    assert.equal(mode.value, "both");
  } finally {
    url.value = "moqt://127.0.0.1:4443/";
  }
});

// 副題のリンクのクエリは、mode 以外の設定を buildQueryString と同じ形で保つ
test("buildQueryStringForMode: mode 以外の設定は buildQueryString と同じクエリになる", () => {
  mode.value = "both";
  url.value = "moqt://example.com/moqt";
  catalogSubscriptionTimeout.value = 30000;
  useDedicatedWorker.value = false;
  try {
    const baseParams = new URLSearchParams(buildQueryString());
    const publisherParams = new URLSearchParams(buildQueryStringForMode("publisher"));
    // mode 以外のキーと値が一致する
    for (const [key, value] of baseParams) {
      assert.equal(publisherParams.get(key), value, `${key} が保たれる`);
    }
    assert.equal(publisherParams.get("mode"), "publisher");
    // both のクエリには mode が載らない
    assert.isNull(baseParams.get("mode"));
  } finally {
    url.value = "moqt://127.0.0.1:4443/";
    catalogSubscriptionTimeout.value = 5000;
    useDedicatedWorker.value = true;
  }
  mode.value = "both";
});

// Catalog Timeout は他の数値の設定と同じく Copy URL に常に載せ、開き直すと select の値が戻る
test("buildQueryString: catalogSubscriptionTimeout を URL で往復できる", () => {
  catalogSubscriptionTimeout.value = 5000;
  assert.equal(new URLSearchParams(buildQueryString()).get("catalogSubscriptionTimeout"), "5000");

  initFromUrl("catalogSubscriptionTimeout=30000");
  assert.equal(catalogSubscriptionTimeout.value, 30000);
  assert.equal(new URLSearchParams(buildQueryString()).get("catalogSubscriptionTimeout"), "30000");

  catalogSubscriptionTimeout.value = 5000;
});

// Catalog Timeout は選択肢のどの値も URL で往復できる
test("initFromUrl / buildQueryString: catalogSubscriptionTimeout は全ての選択肢を往復できる", () => {
  for (const timeout of CATALOG_SUBSCRIPTION_TIMEOUTS) {
    catalogSubscriptionTimeout.value = 5000;
    initFromUrl(`catalogSubscriptionTimeout=${timeout}`);
    assert.equal(catalogSubscriptionTimeout.value, timeout, `${timeout} を復元する`);
    assert.equal(
      new URLSearchParams(buildQueryString()).get("catalogSubscriptionTimeout"),
      String(timeout),
      `${timeout} を URL に載せる`,
    );
  }
  catalogSubscriptionTimeout.value = 5000;
});

// 選択肢に無い値や空文字の catalogSubscriptionTimeout は無視する
// (select の表示が空にならないようにする)
test("initFromUrl: 選択肢に無い catalogSubscriptionTimeout は無視する", () => {
  catalogSubscriptionTimeout.value = 5000;
  initFromUrl("catalogSubscriptionTimeout=12345");
  assert.equal(catalogSubscriptionTimeout.value, 5000);
  initFromUrl("catalogSubscriptionTimeout=");
  assert.equal(catalogSubscriptionTimeout.value, 5000);
  initFromUrl("catalogSubscriptionTimeout=0");
  assert.equal(catalogSubscriptionTimeout.value, 5000);
});

// Dedicated Worker は既定で有効のため Copy URL に載せず、無効のときだけ載せる
test("buildQueryString: useDedicatedWorker を無効にした設定を URL で往復できる", () => {
  useDedicatedWorker.value = true;
  assert.isNull(new URLSearchParams(buildQueryString()).get("useDedicatedWorker"));

  useDedicatedWorker.value = false;
  const query = buildQueryString();
  assert.equal(new URLSearchParams(query).get("useDedicatedWorker"), "0");

  useDedicatedWorker.value = true;
  initFromUrl(query);
  assert.isFalse(useDedicatedWorker.value);

  useDedicatedWorker.value = true;
});

// useDedicatedWorker は =0 / =1 だけを受け付け、それ以外の値は無視する
test("initFromUrl: 0 / 1 以外の useDedicatedWorker は無視する", () => {
  useDedicatedWorker.value = true;
  initFromUrl("useDedicatedWorker=yes");
  assert.isTrue(useDedicatedWorker.value);
  initFromUrl("useDedicatedWorker=0");
  assert.isFalse(useDedicatedWorker.value);
  initFromUrl("useDedicatedWorker=1");
  assert.isTrue(useDedicatedWorker.value);
});
