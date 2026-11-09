/**
 * C4M のテストベクタ
 *
 * draft-ietf-moq-c4m-02 付録 A の JSON を定数化したもので、値を改変しない。
 * 付録 A で折り返された hex / base64url は、同付録の規則 (改行と、その後に続く
 * インデントを除去する) に従って 1 行に戻している。ページヘッダ / フッタは
 * 含めない。
 *
 * 版の区分:
 *
 * - A.2 (CBOR エンコード) / A.3 (トークン構造) / A.4 (DPoP バインディング) /
 *   A.6 (Composite Claims) / A.7 (トークン検証) は c4m-02 の一次ベクタである
 * - A.5 (MOQT 認可スコープ) も c4m-02 の一次ベクタである。`moqt_admin_wildcard`
 *   だけは原本が旧 C4M 01 の action 0〜8 と ClientSetup / ServerSetup の名前、
 *   action 0 の認可期待を残しており、本文 §2.1 Table 1 と一致しない。原本の
 *   バイト列と付属情報は変更せず、そのまま保持する
 * - A.1 の鍵は c4m-02 の値を使う
 *
 * 旧 c4m-01 付録 A のトークンと `-4` の HMAC の別名は一次ベクタとして使わない。
 * `-4` は RFC 9053 の A192KW であり、HMAC-SHA256 ではない。C4M 02 の Token
 * Type 1 の一次ワイヤ形式は COSE (COSE_Mac0 / COSE_Sign1) である。
 *
 * A.6 の Composite Claims は未割当の claim key 0 を placeholder に使う。0 は
 * RFC 8392 Section 9.1.2 が RESERVED として予約しており有効な claim key ではない
 * ため、これらのベクタを割当済みの正常な CAT として扱わない。
 *
 * これらのベクタによる検証は、一次資料のバイト列に対する CBOR / COSE / 暗号の
 * 検証である。実リレーとの相互接続 (リレーがトークンを受理するか) は対象にしない。
 */

/** 付録 A.1 の HMAC-SHA256 鍵 */
export const HMAC_KEY_HEX = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

/** 付録 A.1 の ES256 秘密鍵 (スカラー) */
export const ES256_PRIVATE_KEY_HEX =
  "c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721";

/** 付録 A.1 の ES256 公開鍵の x 座標 */
export const ES256_PUBLIC_KEY_X_HEX =
  "60fed4ba255a9d31c961eb74c6356d68c049b8923b61fa6ce669622e60f29fb6";

/** 付録 A.1 の ES256 公開鍵の y 座標 */
export const ES256_PUBLIC_KEY_Y_HEX =
  "7903fe1008b8bc99a41ae9e95628bc64f2f1b20c2d7e9f5177a3c294d4462299";

/** 付録 A.2 の CBOR エンコードのベクタ */
export interface ClaimVector {
  /** ベクタの識別子 */
  id: string;
  /** claims の CBOR バイト列 (hex) */
  payloadHex: string;
}

/** 付録 A.2 のベクタ一覧 */
export const CLAIM_VECTORS: ClaimVector[] = [
  {
    id: "cbor_issuer_only",
    payloadHex: "a101781868747470733a2f2f617574682e6578616d706c652e636f6d",
  },
  {
    id: "cbor_core_claims",
    payloadHex:
      "a501781868747470733a2f2f617574682e6578616d706c652e636f6d0381781968747470733a2f2f72656c61792e6578616d706c652e636f6d041a65554280051a6553f100074e746573742d746f6b656e2d303031",
  },
  {
    id: "cbor_cat_version_uri",
    payloadHex: "a219013601190138a101a1006b6578616d706c652e636f6d",
  },
  {
    id: "cbor_network_identifiers",
    payloadHex: "a119013784d83444c0a80164d8348208410a19fc008219fc0019fd00",
  },
  {
    id: "cbor_geographic_claims",
    payloadHex:
      "a419011a6639713879796b19013c8262555362434119013d8183fb4042e32fec56d5d0fbc05e9ad77318fc50186419013e820a05",
  },
  {
    id: "cbor_uri_match_rules",
    payloadHex: "a1190138a301a1006b6578616d706c652e636f6d03a101652f766f642f08a100652e6d337538",
  },
  {
    id: "cbor_catu_with_moqt",
    payloadHex:
      "a2190138a201a1006b6578616d706c652e636f6d03a101652f766f642f3a00010000a1008182820407824b6578616d706c652e636f6d43766f64",
  },
  {
    id: "cbor_alpn",
    payloadHex: "a119013a82466d6f712d3030426833",
  },
];

/**
 * 付録 A.3 のトークン構造のベクタ
 *
 * `signatureHex` は COSE_Mac0 では tag、COSE_Sign1 では signature を表す。
 * `coseHex` と `coseB64` は同じ完全な COSE 構造の hex / base64url 表現である。
 */
export interface TokenVector {
  /** ベクタの識別子 */
  id: string;
  /** COSE ヘッダの `alg` の識別子 (RFC 9053) */
  algorithmId: number;
  /** protected ヘッダの CBOR バイト列 (hex) */
  headerHex: string;
  /** claims の CBOR バイト列 (hex) */
  payloadHex: string;
  /** COSE_Mac0 の tag / COSE_Sign1 の signature (hex) */
  signatureHex: string;
  /** 完全な COSE 構造の CBOR バイト列 (hex) */
  coseHex: string;
  /** 完全な COSE 構造の base64url */
  coseB64: string;
}

/** 付録 A.3 のベクタ一覧 */
export const TOKEN_VECTORS: TokenVector[] = [
  {
    id: "token_hmac_minimal",
    algorithmId: 5,
    headerHex: "a201051063434154",
    payloadHex:
      "a301781868747470733a2f2f617574682e6578616d706c652e636f6d0381781968747470733a2f2f72656c61792e6578616d706c652e636f6d041a65554280",
    signatureHex: "16ca16a2d4e2476528ae858d91b00f257a507fe57284bfb13d7d6ca1f065e230",
    coseHex:
      "d18448a201051063434154a0583fa301781868747470733a2f2f617574682e6578616d706c652e636f6d0381781968747470733a2f2f72656c61792e6578616d706c652e636f6d041a65554280582016ca16a2d4e2476528ae858d91b00f257a507fe57284bfb13d7d6ca1f065e230",
    coseB64:
      "0YRIogEFEGNDQVSgWD-jAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tA4F4GWh0dHBzOi8vcmVsYXkuZXhhbXBsZS5jb20EGmVVQoBYIBbKFqLU4kdlKK6FjZGwDyV6UH_lcoS_sT19bKHwZeIw",
  },
  {
    id: "token_hmac_full",
    algorithmId: 5,
    headerHex: "a201051063434154",
    payloadHex:
      "aa01781a68747470733a2f2f6973737565722e6d6f712e6578616d706c650276757365723a616c696365406578616d706c652e636f6d0382781a68747470733a2f2f72656c6179312e6578616d706c652e636f6d781a68747470733a2f2f72656c6179322e6578616d706c652e636f6d041a65554280051a6553f100061a6553f100074a766563746f722d3030321901360119013781d83444cb007132190138a103a101662f6c6976652f",
    signatureHex: "29c1a6612ce6d49273fd8c0116b9decbc287662d5ba5d67defafaf6ff0c11278",
    coseHex:
      "d18448a201051063434154a058abaa01781a68747470733a2f2f6973737565722e6d6f712e6578616d706c650276757365723a616c696365406578616d706c652e636f6d0382781a68747470733a2f2f72656c6179312e6578616d706c652e636f6d781a68747470733a2f2f72656c6179322e6578616d706c652e636f6d041a65554280051a6553f100061a6553f100074a766563746f722d3030321901360119013781d83444cb007132190138a103a101662f6c6976652f582029c1a6612ce6d49273fd8c0116b9decbc287662d5ba5d67defafaf6ff0c11278",
    coseB64:
      "0YRIogEFEGNDQVSgWKuqAXgaaHR0cHM6Ly9pc3N1ZXIubW9xLmV4YW1wbGUCdnVzZXI6YWxpY2VAZXhhbXBsZS5jb20DgngaaHR0cHM6Ly9yZWxheTEuZXhhbXBsZS5jb214Gmh0dHBzOi8vcmVsYXkyLmV4YW1wbGUuY29tBBplVUKABRplU_EABhplU_EAB0p2ZWN0b3ItMDAyGQE2ARkBN4HYNETLAHEyGQE4oQOhAWYvbGl2ZS9YICnBpmEs5tSSc_2MARa53svCh2YtW6XWfe-vr2_wwRJ4",
  },
  {
    id: "token_es256",
    algorithmId: -7,
    headerHex: "a201261063434154",
    payloadHex:
      "a401781868747470733a2f2f617574682e6578616d706c652e636f6d0381781d68747470733a2f2f6d6f712d72656c61792e6578616d706c652e636f6d041a65554280051a6553f100",
    signatureHex:
      "ed8cf586f32ba410f2b3097642eb32255c8dc555e9e058c48084809df557887bc5ee4974a9ef5c4557c1557de799628b634cafaa1b74c936968e0c9c3a48f222",
    coseHex:
      "d28448a201261063434154a05849a401781868747470733a2f2f617574682e6578616d706c652e636f6d0381781d68747470733a2f2f6d6f712d72656c61792e6578616d706c652e636f6d041a65554280051a6553f1005840ed8cf586f32ba410f2b3097642eb32255c8dc555e9e058c48084809df557887bc5ee4974a9ef5c4557c1557de799628b634cafaa1b74c936968e0c9c3a48f222",
    coseB64:
      "0oRIogEmEGNDQVSgWEmkAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tA4F4HWh0dHBzOi8vbW9xLXJlbGF5LmV4YW1wbGUuY29tBBplVUKABRplU_EAWEDtjPWG8yukEPKzCXZC6zIlXI3FVengWMSAhICd9VeIe8XuSXSp71xFV8FVfeeZYotjTK-qG3TJNpaODJw6SPIi",
  },
];

/**
 * 付録 A.4 の DPoP バインディングのベクタ
 *
 * 付録 A.4 のベクタは confirmation key 323 の `jkt` を使う。draft-ietf-moq-c4m-02
 * Section 4.1 は、authorization server が DPoP の鍵束縛に `ckt` (confirmation
 * key 5) を SHOULD、既存の CAT issuer との互換用に `jkt` (key 323) を MAY とし、
 * relay は `ckt` を MUST support、`jkt` を SHOULD support とする。c4m-01 の key 3 は
 * IANA の CWT Confirmation Methods レジストリで `kid` であり、`jkt` ではない。
 * key 3 を `jkt` に読み替えないことは、合成した `cnf` を使う cat.test.ts の
 * テストで固定する。
 */
export interface DpopVector {
  /** ベクタの識別子 */
  id: string;
  /** COSE ヘッダの `alg` の識別子 (HMAC-SHA256 は 5、ES256 は -7) */
  algorithmId: number;
  /** claims の CBOR バイト列 (hex) */
  payloadHex: string;
  /** 完全な COSE 構造の CBOR バイト列 (hex) */
  coseHex: string;
  /** 完全な COSE 構造の base64url */
  coseB64: string;
  /** `cnf` の key 323 (`jkt`) の値 (hex) */
  cnfJktHex: string;
  /** `catdpop` のウィンドウ (秒) */
  windowSeconds: number | undefined;
  /** `catdpop` の jti の扱い */
  honorJti: boolean | undefined;
}

/** 付録 A.4 のベクタ一覧 */
export const DPOP_VECTORS: DpopVector[] = [
  {
    id: "dpop_jwk_binding",
    algorithmId: 5,
    payloadHex:
      "a401781868747470733a2f2f617574682e6578616d706c652e636f6d041a6555428008a119014358200cebf1bc9880748a95588905b79843b42ba75cb174055e3e246bf87fe00b4a6d190141a200183c0101",
    coseHex:
      "d18448a201051063434154a05852a401781868747470733a2f2f617574682e6578616d706c652e636f6d041a6555428008a119014358200cebf1bc9880748a95588905b79843b42ba75cb174055e3e246bf87fe00b4a6d190141a200183c01015820cef11ccef3533e37884638bbff1e08cbcf3d6846afcc0257bf2530416b076242",
    coseB64:
      "0YRIogEFEGNDQVSgWFKkAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tBBplVUKACKEZAUNYIAzr8byYgHSKlViJBbeYQ7Qrp1yxdAVePiRr-H_gC0ptGQFBogAYPAEBWCDO8RzO81M-N4hGOLv_HgjLzz1oRq_MAle_JTBBawdiQg",
    cnfJktHex: "0cebf1bc9880748a95588905b79843b42ba75cb174055e3e246bf87fe00b4a6d",
    windowSeconds: 60,
    honorJti: true,
  },
  {
    id: "dpop_no_jti",
    algorithmId: 5,
    payloadHex:
      "a401781868747470733a2f2f617574682e6578616d706c652e636f6d041a6555428008a119014358203c82dfd6358ba804bd90879c34e743bbe13aeab7980664944f37a0ec0063fe95190141a20019012c0100",
    coseHex:
      "d18448a201051063434154a05853a401781868747470733a2f2f617574682e6578616d706c652e636f6d041a6555428008a119014358203c82dfd6358ba804bd90879c34e743bbe13aeab7980664944f37a0ec0063fe95190141a20019012c01005820ecb7a5b5667b95f20c673417718eac9f5d997fd427485942a61048cdd8c50e0c",
    coseB64:
      "0YRIogEFEGNDQVSgWFOkAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tBBplVUKACKEZAUNYIDyC39Y1i6gEvZCHnDTnQ7vhOuq3mAZklE83oOwAY_6VGQFBogAZASwBAFgg7LeltWZ7lfIMZzQXcY6sn12Zf9QnSFlCphBIzdjFDgw",
    cnfJktHex: "3c82dfd6358ba804bd90879c34e743bbe13aeab7980664944f37a0ec0063fe95",
    windowSeconds: 300,
    honorJti: false,
  },
  {
    id: "dpop_es256_real_binding",
    algorithmId: -7,
    payloadHex:
      "a501781868747470733a2f2f617574682e6578616d706c652e636f6d0381781968747470733a2f2f72656c61792e6578616d706c652e636f6d041a6555428008a119014358200cebf1bc9880748a95588905b79843b42ba75cb174055e3e246bf87fe00b4a6d190141a1001878",
    coseHex:
      "d28448a201261063434154a0586da501781868747470733a2f2f617574682e6578616d706c652e636f6d0381781968747470733a2f2f72656c61792e6578616d706c652e636f6d041a6555428008a119014358200cebf1bc9880748a95588905b79843b42ba75cb174055e3e246bf87fe00b4a6d190141a10018785840cdb69dc3db876b1d05a8f808e5286a861026fc8b58b9a9aa97f23bdf0253ff56357f9129ee9b09667701357c8d700721b3029928d4fe573d56a88744dce04f82",
    coseB64:
      "0oRIogEmEGNDQVSgWG2lAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tA4F4GWh0dHBzOi8vcmVsYXkuZXhhbXBsZS5jb20EGmVVQoAIoRkBQ1ggDOvxvJiAdIqVWIkFt5hDtCunXLF0BV4-JGv4f-ALSm0ZAUGhABh4WEDNtp3D24drHQWo-AjlKGqGECb8i1i5qaqX8jvfAlP_VjV_kSnumwlmdwE1fI1wByGzApko1P5XPVaoh0Tc4E-C",
    cnfJktHex: "0cebf1bc9880748a95588905b79843b42ba75cb174055e3e246bf87fe00b4a6d",
    windowSeconds: 120,
    honorJti: undefined,
  },
];

/** 付録 A.5 の認可テスト */
export interface AuthorizationTest {
  /** アクションの整数値 */
  action: number;
  /** Track Namespace のフィールド (UTF-8) */
  namespace: string[];
  /** Track Name (UTF-8) */
  track: string;
  /** 期待する判定 */
  expected: boolean;
}

/**
 * 付録 A.5 のスコープのベクタ
 *
 * `actionNames` は原本の `moqt_scopes[*].action_names` をそのまま保持する。
 * `moqt_admin_wildcard` の名前と actions は旧 C4M 01 のままで本文 §2.1 Table 1 と
 * 一致しないが、原本の付属情報を変更しない。
 */
export interface ScopeVector {
  /** ベクタの識別子 */
  id: string;
  /** claims の CBOR バイト列 (hex) */
  payloadHex: string;
  /** 完全な COSE 構造の CBOR バイト列 (hex) */
  coseHex: string;
  /** 付録 A.5 の COSE_Mac0 バイト列の base64url (`cose_b64`) */
  token: string;
  /** `moqt-reval` (ある場合) */
  moqtReval: number | undefined;
  /** 原本の `moqt_scopes[*].action_names` */
  actionNames: string[][];
  /** 認可テスト */
  tests: AuthorizationTest[];
}

/** 付録 A.5 のスコープのベクタ一覧 */
export const SCOPE_VECTORS: ScopeVector[] = [
  {
    id: "moqt_publisher_exact",
    payloadHex:
      "a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542803a00010000a1008183820206824b6578616d706c652e636f6d45616c696365820146766964656f2d",
    coseHex:
      "d18448a201051063434154a0584aa301781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542803a00010000a1008183820206824b6578616d706c652e636f6d45616c696365820146766964656f2d5820467c57ade72d6be629b745ef33d6e28ec38ba1ca8bd3feb851f3832af94fe686",
    token:
      "0YRIogEFEGNDQVSgWEqjAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tBBplVUKAOgABAAChAIGDggIGgktleGFtcGxlLmNvbUVhbGljZYIBRnZpZGVvLVggRnxXrecta-Ypt0XvM9bijsOLocqL0_64UfODKvlP5oY",
    moqtReval: undefined,
    actionNames: [["PublishNamespace", "Publish"]],
    tests: [
      {
        action: 2,
        namespace: ["example.com", "alice"],
        track: "video-hd",
        expected: true,
      },
      {
        action: 6,
        namespace: ["example.com", "alice"],
        track: "video-sd",
        expected: true,
      },
      {
        action: 6,
        namespace: ["example.com", "alice"],
        track: "audio-main",
        expected: false,
      },
      {
        action: 4,
        namespace: ["example.com", "alice"],
        track: "video-hd",
        expected: false,
      },
      {
        action: 6,
        namespace: ["example.com", "bob"],
        track: "video-hd",
        expected: false,
      },
    ],
  },
  {
    id: "moqt_subscriber_prefix",
    payloadHex:
      "a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542803a00010000a10081828303040781820152636f6e666572656e63652e6578616d706c65",
    coseHex:
      "d18448a201051063434154a05845a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542803a00010000a10081828303040781820152636f6e666572656e63652e6578616d706c655820e0502202b8c01d5ab61508cd19b7dd943b287be0f26c3d37c12e583ca87a937b",
    token:
      "0YRIogEFEGNDQVSgWEWjAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tBBplVUKAOgABAAChAIGCgwMEB4GCAVJjb25mZXJlbmNlLmV4YW1wbGVYIOBQIgK4wB1athUIzRm33ZQ7KHvg8mw9N8EuWDyoepN7",
    moqtReval: undefined,
    actionNames: [["SubscribeNamespace", "Subscribe", "Fetch"]],
    tests: [
      {
        action: 4,
        namespace: ["conference.example.room1"],
        track: "audio",
        expected: true,
      },
      {
        action: 7,
        namespace: ["conference.example.room2"],
        track: "video",
        expected: true,
      },
      {
        action: 4,
        namespace: ["other.domain"],
        track: "audio",
        expected: false,
      },
      {
        action: 6,
        namespace: ["conference.example.room1"],
        track: "audio",
        expected: false,
      },
    ],
  },
  {
    id: "moqt_multi_scope",
    payloadHex:
      "a401781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542803a00010000a1008282820206824c6c6976652e6578616d706c654873747564696f2d61828204078182014c6c6976652e6578616d706c653a0001000119012c",
    coseHex:
      "d18448a201051063434154a05861a401781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542803a00010000a1008282820206824c6c6976652e6578616d706c654873747564696f2d61828204078182014c6c6976652e6578616d706c653a0001000119012c5820f1080af59a719fbcb7a036aa6f9714f52ada467b8c1677c87ade0fcfccaaf50f",
    token:
      "0YRIogEFEGNDQVSgWGGkAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tBBplVUKAOgABAAChAIKCggIGgkxsaXZlLmV4YW1wbGVIc3R1ZGlvLWGCggQHgYIBTGxpdmUuZXhhbXBsZToAAQABGQEsWCDxCAr1mnGfvLegNqpvlxT1KtpGe4wWd8h63g_PzKr1Dw",
    moqtReval: 300,
    actionNames: [
      ["PublishNamespace", "Publish"],
      ["Subscribe", "Fetch"],
    ],
    tests: [
      {
        action: 6,
        namespace: ["live.example", "studio-a"],
        track: "cam1",
        expected: true,
      },
      {
        action: 4,
        namespace: ["live.example.studio-b"],
        track: "cam1",
        expected: true,
      },
      {
        action: 6,
        namespace: ["live.example", "studio-b"],
        track: "cam1",
        expected: false,
      },
      {
        action: 2,
        namespace: ["other.example", "studio-a"],
        track: "",
        expected: false,
      },
    ],
  },
  {
    id: "moqt_admin_wildcard",
    payloadHex:
      "a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542803a00010000a100818189000102030405060708",
    coseHex:
      "d18448a201051063434154a05835a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542803a00010000a1008181890001020304050607085820172ebe07f227a41c319684ef916fdbf142d391fac6902e38bcdcfb3966b46a50",
    token:
      "0YRIogEFEGNDQVSgWDWjAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tBBplVUKAOgABAAChAIGBiQABAgMEBQYHCFggFy6-B_InpBwxloTvkW_b8ULTkfrGkC44vNz7OWa0alA",
    moqtReval: undefined,
    actionNames: [
      [
        "ClientSetup",
        "ServerSetup",
        "PublishNamespace",
        "SubscribeNamespace",
        "Subscribe",
        "RequestUpdate",
        "Publish",
        "Fetch",
        "TrackStatus",
      ],
    ],
    tests: [
      {
        action: 0,
        namespace: ["any.namespace"],
        track: "any-track",
        expected: true,
      },
      {
        action: 6,
        namespace: ["any.namespace"],
        track: "any-track",
        expected: true,
      },
      {
        action: 8,
        namespace: ["any.namespace"],
        track: "status",
        expected: true,
      },
    ],
  },
  {
    id: "moqt_suffix_match",
    payloadHex:
      "a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542803a00010000a100818381048182024c2e6578616d706c652e636f6d8202462d617564696f",
    coseHex:
      "d18448a201051063434154a05846a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542803a00010000a100818381048182024c2e6578616d706c652e636f6d8202462d617564696f5820602c1ceb2729485a2b5eb09249e254a41d42abd0b63b2846fd677d7fbf593920",
    token:
      "0YRIogEFEGNDQVSgWEajAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tBBplVUKAOgABAAChAIGDgQSBggJMLmV4YW1wbGUuY29tggJGLWF1ZGlvWCBgLBzrJylIWitesJJJ4lSkHUKr0LY7KEb9Z31_v1k5IA",
    moqtReval: undefined,
    actionNames: [["Subscribe"]],
    tests: [
      {
        action: 4,
        namespace: ["cdn.example.com"],
        track: "stream1-audio",
        expected: true,
      },
      {
        action: 4,
        namespace: ["cdn.example.com"],
        track: "stream1-video",
        expected: false,
      },
      {
        action: 4,
        namespace: ["cdn.other.org"],
        track: "stream1-audio",
        expected: false,
      },
    ],
  },
];

/**
 * 付録 A.6 の Composite Claims のベクタ
 *
 * 原本は `or` / `nor` / `and` の claim key が未割当のため、すべて key 0 を
 * placeholder に使うと明記する。0 は RFC 8392 Section 9.1.2 が RESERVED として
 * 予約しており有効な claim key ではない。したがってこのベクタを正常な CAT として
 * 扱わず、複合クレームの実装済みを示す根拠にも使わない。テストでは原本の payload
 * バイト列に対する COSE の MAC 検証と、key 0 を含むため CAT として拒否することの
 * 確認を行う。
 */
interface CompositeVector {
  /** ベクタの識別子 */
  id: string;
  /** 原本が placeholder に使う claim key。0 は有効な claim key ではない */
  claimKey: number;
  /** claims の CBOR バイト列 (hex) */
  payloadHex: string;
  /** 完全な COSE 構造の CBOR バイト列 (hex) */
  coseHex: string;
  /** 完全な COSE 構造の base64url */
  coseB64: string;
}

/** 付録 A.6 のベクタ一覧 */
export const COMPOSITE_VECTORS: CompositeVector[] = [
  {
    id: "composite_or_simple",
    claimKey: 0,
    payloadHex:
      "a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542800082a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a6555428019013601a301781f68747470733a2f2f617574682d6261636b75702e6578616d706c652e636f6d041a6555509019013601",
    coseHex:
      "d18448a201051063434154a05877a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542800082a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a6555428019013601a301781f68747470733a2f2f617574682d6261636b75702e6578616d706c652e636f6d041a655550901901360158208ebb4ac5a34771116903baff5e544f3047468faeb077820f26ea2df940b6c58d",
    coseB64:
      "0YRIogEFEGNDQVSgWHejAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tBBplVUKAAIKjAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tBBplVUKAGQE2AaMBeB9odHRwczovL2F1dGgtYmFja3VwLmV4YW1wbGUuY29tBBplVVCQGQE2AVggjrtKxaNHcRFpA7r_XlRPMEdGj66wd4IPJuot-UC2xY0",
  },
  {
    id: "composite_and",
    claimKey: 0,
    payloadHex:
      "a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542800082a2041a6555428019013601a2041a6555428019013781d834440a000000",
    coseHex:
      "d18448a201051063434154a05841a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542800082a2041a6555428019013601a2041a6555428019013781d834440a00000058208ca3213e71dfe3900fd910fcb7f6d365949e72e81ceba80f2ff24048502e9a1a",
    coseB64:
      "0YRIogEFEGNDQVSgWEGjAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tBBplVUKAAIKiBBplVUKAGQE2AaIEGmVVQoAZATeB2DRECgAAAFggjKMhPnHf45AP2RD8t_bTZZSecugc66gPL_JASFAumho",
  },
  {
    id: "composite_nor",
    claimKey: 0,
    payloadHex:
      "a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542800081a201781b68747470733a2f2f7265766f6b65642e6578616d706c652e636f6d041a65554280",
    coseHex:
      "d18448a201051063434154a05849a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542800081a201781b68747470733a2f2f7265766f6b65642e6578616d706c652e636f6d041a655542805820a5419cd0db084ac9efc26c21ff2663b4ec0cff6622ae48719f65738cb93fd19e",
    coseB64:
      "0YRIogEFEGNDQVSgWEmjAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tBBplVUKAAIGiAXgbaHR0cHM6Ly9yZXZva2VkLmV4YW1wbGUuY29tBBplVUKAWCClQZzQ2whKye_CbCH_JmO07Az_ZiKuSHGfZXOMuT_Rng",
  },
  {
    id: "composite_nested",
    claimKey: 0,
    payloadHex:
      "a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542800082a201781b68747470733a2f2f7072696d6172792e6578616d706c652e636f6d041a65554280a10082a201781d68747470733a2f2f7365636f6e646172792e6578616d706c652e636f6d041a65554280a2041a6555428019013601",
    coseHex:
      "d18448a201051063434154a0587ea301781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542800082a201781b68747470733a2f2f7072696d6172792e6578616d706c652e636f6d041a65554280a10082a201781d68747470733a2f2f7365636f6e646172792e6578616d706c652e636f6d041a65554280a2041a65554280190136015820c60304bcd67f2f78bf9e83e84fe3a2d13f8e809659a32cc480c76cfe5ae1da06",
    coseB64:
      "0YRIogEFEGNDQVSgWH6jAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tBBplVUKAAIKiAXgbaHR0cHM6Ly9wcmltYXJ5LmV4YW1wbGUuY29tBBplVUKAoQCCogF4HWh0dHBzOi8vc2Vjb25kYXJ5LmV4YW1wbGUuY29tBBplVUKAogQaZVVCgBkBNgFYIMYDBLzWfy94v56D6E_jotE_joCWWaMsxIDHbP5a4doG",
  },
];

/**
 * 付録 A.7 の検証ベクタの `validation`
 *
 * `expectedError` は一次資料の文字列をそのまま保持する。実装のエラー型 / コード
 * への対応は cat.test.ts の対応表を参照する。
 */
interface ValidationVectorValidation {
  /** 検証に使う現在時刻 */
  referenceTime: number | undefined;
  /** 期待する `iss` */
  expectedIssuers: string[];
  /** 期待する `aud` */
  expectedAudiences: string[];
  /** 期待するエラー (undefined は正常) */
  expectedError: string | undefined;
  /** 検証に使う鍵 (hex、未指定は A.1 の hmac_sha256) */
  keyHex: string | undefined;
  /** 正しい鍵 (誤鍵ベクタ) */
  correctKeyHex: string | undefined;
  /** 誤った鍵 (誤鍵ベクタ) */
  wrongKeyHex: string | undefined;
  /** トークン自身のアルゴリズム id (形式不一致ベクタ) */
  tokenAlgorithmId: number | undefined;
  /** 検証側が期待するアルゴリズム id (形式不一致ベクタ) */
  verifierAlgorithmId: number | undefined;
}

/**
 * 付録 A.7 の検証ベクタ
 *
 * すべて COSE_Mac0 (HMAC-SHA256、algorithm_id 5) の完全な base64url トークンである。
 */
export interface ValidationVector {
  /** ベクタの識別子 */
  id: string;
  /** base64url の完全な COSE_Mac0 (一次資料の token) */
  token: string;
  /** 改ざん前の COSE バイト列 (原本の `original_cose_hex`) */
  originalCoseHex: string | undefined;
  /** 一次資料の `validation` */
  validation: ValidationVectorValidation;
}

/** 付録 A.7 のベクタ一覧 */
export const VALIDATION_VECTORS: ValidationVector[] = [
  {
    id: "valid_basic",
    token:
      "0YRIogEFEGNDQVSgWEWkAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tA4F4GWh0dHBzOi8vcmVsYXkuZXhhbXBsZS5jb20EGmVVQoAFGmVT8QBYIP30vfENhlwaLMuZjMPeYXjz8QWuqCDlyzStGQVQ4_xi",
    originalCoseHex: undefined,
    validation: {
      referenceTime: 1700003600,
      expectedIssuers: ["https://auth.example.com"],
      expectedAudiences: ["https://relay.example.com"],
      expectedError: undefined,
      keyHex: undefined,
      correctKeyHex: undefined,
      wrongKeyHex: undefined,
      tokenAlgorithmId: undefined,
      verifierAlgorithmId: undefined,
    },
  },
  {
    id: "invalid_expired",
    token:
      "0YRIogEFEGNDQVSgWCKiAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tBBpfXhAAWCDNInUDQ2qsHo8l8Gj0tzb1HIYIpBheVbVoItgT7Ua6aA",
    originalCoseHex: undefined,
    validation: {
      referenceTime: 1700000000,
      expectedIssuers: [],
      expectedAudiences: [],
      expectedError: "TokenExpired",
      keyHex: undefined,
      correctKeyHex: undefined,
      wrongKeyHex: undefined,
      tokenAlgorithmId: undefined,
      verifierAlgorithmId: undefined,
    },
  },
  {
    id: "invalid_not_yet_valid",
    token:
      "0YRIogEFEGNDQVSgWCijAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tBBplVpQABRplVUKAWCArREpqUH1KiIrMzevyeLr6t_y-L6oheaJGUU9hwhYRbg",
    originalCoseHex: undefined,
    validation: {
      referenceTime: 1700000000,
      expectedIssuers: [],
      expectedAudiences: [],
      expectedError: "TokenNotYetValid",
      keyHex: undefined,
      correctKeyHex: undefined,
      wrongKeyHex: undefined,
      tokenAlgorithmId: undefined,
      verifierAlgorithmId: undefined,
    },
  },
  {
    id: "invalid_wrong_issuer",
    token:
      "0YRIogEFEGNDQVSgWD-jAXgYaHR0cHM6Ly9ldmlsLmV4YW1wbGUuY29tA4F4GWh0dHBzOi8vcmVsYXkuZXhhbXBsZS5jb20EGmVVQoBYIOmQtbjAMxCnCDlMbHiF-XZlN1SV6QSqkZWTguttCpaC",
    originalCoseHex: undefined,
    validation: {
      referenceTime: 1700003600,
      expectedIssuers: ["https://auth.example.com"],
      expectedAudiences: [],
      expectedError: "InvalidIssuer",
      keyHex: undefined,
      correctKeyHex: undefined,
      wrongKeyHex: undefined,
      tokenAlgorithmId: undefined,
      verifierAlgorithmId: undefined,
    },
  },
  {
    id: "invalid_wrong_audience",
    token:
      "0YRIogEFEGNDQVSgWEWjAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tA4F4H2h0dHBzOi8vb3RoZXItcmVsYXkuZXhhbXBsZS5jb20EGmVVQoBYIOeCJJJNAkaNHBBkOdcSFVXKNNj0D8GdGkLmOriIB2pX",
    originalCoseHex: undefined,
    validation: {
      referenceTime: 1700003600,
      expectedIssuers: ["https://auth.example.com"],
      expectedAudiences: ["https://relay.example.com"],
      expectedError: "InvalidAudience",
      keyHex: undefined,
      correctKeyHex: undefined,
      wrongKeyHex: undefined,
      tokenAlgorithmId: undefined,
      verifierAlgorithmId: undefined,
    },
  },
  {
    id: "invalid_tampered_signature",
    token:
      "0YRIogEFEGNDQVSgWD-jAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tA4F4GWh0dHBzOi8vcmVsYXkuZXhhbXBsZS5jb20EGmVVQoBYIOnKFqLU4kdlKK6FjZGwDyV6UH_lcoS_sT19bKHwZeIw",
    originalCoseHex:
      "d18448a201051063434154a0583fa301781868747470733a2f2f617574682e6578616d706c652e636f6d0381781968747470733a2f2f72656c61792e6578616d706c652e636f6d041a65554280582016ca16a2d4e2476528ae858d91b00f257a507fe57284bfb13d7d6ca1f065e230",
    validation: {
      referenceTime: undefined,
      expectedIssuers: [],
      expectedAudiences: [],
      expectedError: "SignatureVerificationFailed",
      keyHex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      correctKeyHex: undefined,
      wrongKeyHex: undefined,
      tokenAlgorithmId: undefined,
      verifierAlgorithmId: undefined,
    },
  },
  {
    id: "invalid_wrong_key",
    token:
      "0YRIogEFEGNDQVSgWCKiAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tBBplVUKAWCCqD2TUB2jOEalC6kta2ptR7vx6flZ0I9L0RV3MCbZ-Aw",
    originalCoseHex: undefined,
    validation: {
      referenceTime: undefined,
      expectedIssuers: [],
      expectedAudiences: [],
      expectedError: "SignatureVerificationFailed",
      keyHex: undefined,
      correctKeyHex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      wrongKeyHex: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      tokenAlgorithmId: undefined,
      verifierAlgorithmId: undefined,
    },
  },
  {
    id: "invalid_algorithm_mismatch",
    token:
      "0YRIogEFEGNDQVSgWCKiAXgYaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tBBplVUKAWCCqD2TUB2jOEalC6kta2ptR7vx6flZ0I9L0RV3MCbZ-Aw",
    originalCoseHex: undefined,
    validation: {
      referenceTime: undefined,
      expectedIssuers: [],
      expectedAudiences: [],
      expectedError: "InvalidTokenFormat",
      keyHex: undefined,
      correctKeyHex: undefined,
      wrongKeyHex: undefined,
      tokenAlgorithmId: 5,
      verifierAlgorithmId: -7,
    },
  },
];
