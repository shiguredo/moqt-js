/**
 * draft-ietf-moq-c4m-01 付録 A のテストベクタ
 *
 * refs/moq/draft-ietf-moq-c4m-01.txt の付録 A の JSON をそのまま定数化したもので、
 * 改変しない。
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
    id: "cbor_cat_version_usage",
    payloadHex: "a2190136664341542d763119013805",
  },
  {
    id: "cbor_network_identifiers",
    payloadHex:
      "a1190137846d3139322e3136382e312e313030a16869705f72616e67656a31302e302e302e302f38a16361736e19fc00a16961736e5f72616e67658219fc0019fd00",
  },
  {
    id: "cbor_geographic_claims",
    payloadHex:
      "a419011a6639713879796b19013c8262555362434119013da3636c6174fb4042e32fec56d5d0636c6f6efbc05e9ad77318fc50686163637572616379f9564019013e0a",
  },
  {
    id: "cbor_uri_patterns",
    payloadHex:
      "a119013b83782068747470733a2f2f6578616d706c652e636f6d2f6c6976652f73747265616d31a166707265666978781868747470733a2f2f6578616d706c652e636f6d2f766f642fa166737566666978652e6d337538",
  },
  {
    id: "cbor_alpn",
    payloadHex: "a119013a82666d6f712d3030626833",
  },
];

/** 付録 A.3 のトークン構造のベクタ */
export interface TokenVector {
  /** ベクタの識別子 */
  id: string;
  /** protected ヘッダの CBOR バイト列 (hex) */
  headerHex: string;
  /** claims の CBOR バイト列 (hex) */
  payloadHex: string;
  /** 署名 (hex) */
  signatureHex: string;
  /** compact 形式のトークン */
  token: string;
  /** `alg` の識別子 */
  algorithmId: number;
  /** `iss` */
  issuer: string | undefined;
  /** `aud` */
  audience: string[];
  /** `exp` */
  expiration: number | undefined;
  /** `nbf` */
  notBefore: number | undefined;
  /** `iat` */
  issuedAt: number | undefined;
  /** `sub` */
  subject: string | undefined;
  /** `cti` */
  cwtId: string | undefined;
}

/** 付録 A.3 のベクタ一覧 */
export const TOKEN_VECTORS: TokenVector[] = [
  {
    id: "token_hmac_minimal",
    headerHex: "a201231063434154",
    payloadHex:
      "a301781868747470733a2f2f617574682e6578616d706c652e636f6d0381781968747470733a2f2f72656c61792e6578616d706c652e636f6d041a65554280",
    signatureHex: "5b5ec60fb1a3f81d18b5e8d7edf4702e55261248def8c13cd6809cf6865a6986",
    token:
      "ogEjEGNDQVQ.owF4GGh0dHBzOi8vYXV0aC5leGFtcGxlLmNvbQOBeBlodHRwczovL3JlbGF5LmV4YW1wbGUuY29tBBplVUKA.W17GD7Gj-B0YtejX7fRwLlUmEkje-ME81oCc9oZaaYY",
    algorithmId: -4,
    issuer: "https://auth.example.com",
    audience: ["https://relay.example.com"],
    expiration: 1700086400,
    notBefore: undefined,
    issuedAt: undefined,
    subject: undefined,
    cwtId: undefined,
  },
  {
    id: "token_hmac_full",
    headerHex: "a201231063434154",
    payloadHex:
      "aa01781a68747470733a2f2f6973737565722e6d6f712e6578616d706c650276757365723a616c696365406578616d706c652e636f6d0382781a68747470733a2f2f72656c6179312e6578616d706c652e636f6d781a68747470733a2f2f72656c6179322e6578616d706c652e636f6d041a65554280051a6553f100061a6553f100074a766563746f722d303032190136664341542d7631190137816c3230332e302e3131332e35301901380a",
    signatureHex: "02aa58a31e34ab53fab3c755b47cf08f458a3603da4d933d7c0b1ce4614f44da",
    token:
      "ogEjEGNDQVQ.qgF4Gmh0dHBzOi8vaXNzdWVyLm1vcS5leGFtcGxlAnZ1c2VyOmFsaWNlQGV4YW1wbGUuY29tA4J4Gmh0dHBzOi8vcmVsYXkxLmV4YW1wbGUuY29teBpodHRwczovL3JlbGF5Mi5leGFtcGxlLmNvbQQaZVVCgAUaZVPxAAYaZVPxAAdKdmVjdG9yLTAwMhkBNmZDQVQtdjEZATeBbDIwMy4wLjExMy41MBkBOAo.AqpYox40q1P6s8dVtHzwj0WKNgPaTZM9fAsc5GFPRNo",
    algorithmId: -4,
    issuer: "https://issuer.moq.example",
    audience: ["https://relay1.example.com", "https://relay2.example.com"],
    expiration: 1700086400,
    notBefore: 1700000000,
    issuedAt: 1700000000,
    subject: "user:alice@example.com",
    cwtId: "vector-002",
  },
  {
    id: "token_es256",
    headerHex: "a201261063434154",
    payloadHex:
      "a401781868747470733a2f2f617574682e6578616d706c652e636f6d0381781d68747470733a2f2f6d6f712d72656c61792e6578616d706c652e636f6d041a65554280051a6553f100",
    signatureHex:
      "fa3315e9de061fd77d814394428ae61da3d7a21fdffb19802b0c575c578098e7cd4b6b75a1690deed4c2baae994bfc462e0d8a2006f3e89780f3435738294d7a",
    token:
      "ogEmEGNDQVQ.pAF4GGh0dHBzOi8vYXV0aC5leGFtcGxlLmNvbQOBeB1odHRwczovL21vcS1yZWxheS5leGFtcGxlLmNvbQQaZVVCgAUaZVPxAA.-jMV6d4GH9d9gUOUQormHaPXoh_f-xmAKwxXXFeAmOfNS2t1oWkN7tTCuq6ZS_xGLg2KIAbz6JeA80NXOClNeg",
    algorithmId: -7,
    issuer: "https://auth.example.com",
    audience: ["https://moq-relay.example.com"],
    expiration: 1700086400,
    notBefore: 1700000000,
    issuedAt: undefined,
    subject: undefined,
    cwtId: undefined,
  },
];

/** 付録 A.4 の DPoP バインディングのベクタ */
export interface DpopVector {
  /** ベクタの識別子 */
  id: string;
  /** claims の CBOR バイト列 (hex) */
  payloadHex: string;
  /** compact 形式のトークン */
  token: string;
  /** `cnf` の JWK サムプリント (hex) */
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
    payloadHex:
      "a401781868747470733a2f2f617574682e6578616d706c652e636f6d041a6555428008a1035820a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1190141a200183c0101",
    token:
      "ogEjEGNDQVQ.pAF4GGh0dHBzOi8vYXV0aC5leGFtcGxlLmNvbQQaZVVCgAihA1ggoLHC0-T1prfI2eDxorPE1eb3qLnA0eLzpLXG1-j5oLEZAUGiABg8AQE.sN9kLIp64zIN9zDXoTLYC0xsJU_1FNF3kaO0CbdA_3M",
    cnfJktHex: "a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1",
    windowSeconds: 60,
    honorJti: true,
  },
  {
    id: "dpop_no_jti",
    payloadHex:
      "a401781868747470733a2f2f617574682e6578616d706c652e636f6d041a6555428008a10358203c82dfd6358ba804bd90879c34e743bbe13aeab7980664944f37a0ec0063fe95190141a20019012c0100",
    token:
      "ogEjEGNDQVQ.pAF4GGh0dHBzOi8vYXV0aC5leGFtcGxlLmNvbQQaZVVCgAihA1ggPILf1jWLqAS9kIecNOdDu-E66reYBmSUTzeg7ABj_pUZAUGiABkBLAEA.M4lF5pQdxav6eIWqDjbchDkijVYOM7xa3oJR2IwWt9g",
    cnfJktHex: "3c82dfd6358ba804bd90879c34e743bbe13aeab7980664944f37a0ec0063fe95",
    windowSeconds: 300,
    honorJti: false,
  },
  {
    id: "dpop_es256_real_binding",
    payloadHex:
      "a501781868747470733a2f2f617574682e6578616d706c652e636f6d0381781968747470733a2f2f72656c61792e6578616d706c652e636f6d041a6555428008a10358200cebf1bc9880748a95588905b79843b42ba75cb174055e3e246bf87fe00b4a6d190141a1001878",
    token:
      "ogEmEGNDQVQ.pQF4GGh0dHBzOi8vYXV0aC5leGFtcGxlLmNvbQOBeBlodHRwczovL3JlbGF5LmV4YW1wbGUuY29tBBplVUKACKEDWCAM6_G8mIB0ipVYiQW3mEO0K6dcsXQFXj4ka_h_4AtKbRkBQaEAGHg.5andoxOhWXQIKWR3EMHWT-WIMPBDMYQFc61nzlfZs8zmgzwcOARpmlaB3ZS5MbJ9iCYWykYAcIzJ81nMyyZoQw",
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

/** 付録 A.5 のスコープのベクタ */
export interface ScopeVector {
  /** ベクタの識別子 */
  id: string;
  /** claims の CBOR バイト列 (hex) */
  payloadHex: string;
  /** compact 形式のトークン */
  token: string;
  /** `moqt-reval` (ある場合) */
  moqtReval: number | undefined;
  /** 認可テスト */
  tests: AuthorizationTest[];
}

/** 付録 A.5 のベクタ一覧 */
export const SCOPE_VECTORS: ScopeVector[] = [
  {
    id: "moqt_publisher_exact",
    payloadHex:
      "a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542801901478183820206824b6578616d706c652e636f6d45616c696365820146766964656f2d",
    token:
      "ogEjEGNDQVQ.owF4GGh0dHBzOi8vYXV0aC5leGFtcGxlLmNvbQQaZVVCgBkBR4GDggIGgktleGFtcGxlLmNvbUVhbGljZYIBRnZpZGVvLQ.oAPD24Wu_zHnDcuM6a-ePeGvRJjbCa6U7iswdsKzFDk",
    moqtReval: undefined,
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
      "a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a6555428019014781828303040781820152636f6e666572656e63652e6578616d706c65",
    token:
      "ogEjEGNDQVQ.owF4GGh0dHBzOi8vYXV0aC5leGFtcGxlLmNvbQQaZVVCgBkBR4GCgwMEB4GCAVJjb25mZXJlbmNlLmV4YW1wbGU.pfUPZultmyCm1GF2PvPXAYXzvK6d1D-OFNBLG1AwjDg",
    moqtReval: undefined,
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
      "a401781868747470733a2f2f617574682e6578616d706c652e636f6d041a655542801901478282820206824c6c6976652e6578616d706c654873747564696f2d61828204078182014c6c6976652e6578616d706c65190148f95cb0",
    token:
      "ogEjEGNDQVQ.pAF4GGh0dHBzOi8vYXV0aC5leGFtcGxlLmNvbQQaZVVCgBkBR4KCggIGgkxsaXZlLmV4YW1wbGVIc3R1ZGlvLWGCggQHgYIBTGxpdmUuZXhhbXBsZRkBSPlcsA.byEzQmxc28UXFyFekHtgOtaVmWyIPl-63xNMOF0Q_IU",
    moqtReval: 300,
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
      "a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a65554280190147818189000102030405060708",
    token:
      "ogEjEGNDQVQ.owF4GGh0dHBzOi8vYXV0aC5leGFtcGxlLmNvbQQaZVVCgBkBR4GBiQABAgMEBQYHCA.XlNItz7OGqnNEbaqZ_bQh6TL-wV6SDr8hXyOLmtQkj4",
    moqtReval: undefined,
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
      "a301781868747470733a2f2f617574682e6578616d706c652e636f6d041a65554280190147818381048182024c2e6578616d706c652e636f6d8202462d617564696f",
    token:
      "ogEjEGNDQVQ.owF4GGh0dHBzOi8vYXV0aC5leGFtcGxlLmNvbQQaZVVCgBkBR4GDgQSBggJMLmV4YW1wbGUuY29tggJGLWF1ZGlv.-eGYTPe_n1PeC0sgHdWCqgnKRHGYF-T89WTk269liBg",
    moqtReval: undefined,
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

/** 付録 A.6 の検証ベクタ */
export interface ValidationVector {
  /** ベクタの識別子 */
  id: string;
  /** compact 形式のトークン */
  token: string;
  /** 検証に使う現在時刻 */
  referenceTime: number | undefined;
  /** 期待する `iss` */
  expectedIssuers: string[];
  /** 期待する `aud` */
  expectedAudiences: string[];
  /** 期待するエラー (undefined は正常) */
  expectedError: string | undefined;
  /** 検証に使う鍵 (hex) */
  keyHex: string | undefined;
  /** 検証側が期待するアルゴリズム id */
  verifierAlgorithmId: number | undefined;
}

/** 付録 A.6 のベクタ一覧 */
export const VALIDATION_VECTORS: ValidationVector[] = [
  {
    id: "valid_basic",
    token:
      "ogEjEGNDQVQ.pAF4GGh0dHBzOi8vYXV0aC5leGFtcGxlLmNvbQOBeBlodHRwczovL3JlbGF5LmV4YW1wbGUuY29tBBplVUKABRplU_EA.9SztgnG4xgw8U9zDFnqPIuPn6hLwuilSigQcfPsArSg",
    referenceTime: 1700003600,
    expectedIssuers: ["https://auth.example.com"],
    expectedAudiences: ["https://relay.example.com"],
    expectedError: undefined,
    keyHex: undefined,
    verifierAlgorithmId: undefined,
  },
  {
    id: "invalid_expired",
    token:
      "ogEjEGNDQVQ.ogF4GGh0dHBzOi8vYXV0aC5leGFtcGxlLmNvbQQaX14QAA.lq8nGBiZm80yUwl1kH_Tv2prKu_nV20JvxVJW8ZGkho",
    referenceTime: 1700000000,
    expectedIssuers: [],
    expectedAudiences: [],
    expectedError: "TokenExpired",
    keyHex: undefined,
    verifierAlgorithmId: undefined,
  },
  {
    id: "invalid_not_yet_valid",
    token:
      "ogEjEGNDQVQ.owF4GGh0dHBzOi8vYXV0aC5leGFtcGxlLmNvbQQaZVaUAAUaZVVCgA.fPIUugY7_oSeHlheu83_8Yyljsk3iP2zGeWRUi7NtUs",
    referenceTime: 1700000000,
    expectedIssuers: [],
    expectedAudiences: [],
    expectedError: "TokenNotYetValid",
    keyHex: undefined,
    verifierAlgorithmId: undefined,
  },
  {
    id: "invalid_wrong_issuer",
    token:
      "ogEjEGNDQVQ.owF4GGh0dHBzOi8vZXZpbC5leGFtcGxlLmNvbQOBeBlodHRwczovL3JlbGF5LmV4YW1wbGUuY29tBBplVUKA.Xo7FCr_MGSyVX0C9sueeapSfboIHkrkysurn2VjC9PU",
    referenceTime: 1700003600,
    expectedIssuers: ["https://auth.example.com"],
    expectedAudiences: [],
    expectedError: "InvalidIssuer",
    keyHex: undefined,
    verifierAlgorithmId: undefined,
  },
  {
    id: "invalid_wrong_audience",
    token:
      "ogEjEGNDQVQ.owF4GGh0dHBzOi8vYXV0aC5leGFtcGxlLmNvbQOBeB9odHRwczovL290aGVyLXJlbGF5LmV4YW1wbGUuY29tBBplVUKA.b8KxAKxJglzhELMuc9bYmsikrx3F9Y3YdvpfHLbsyk0",
    referenceTime: 1700003600,
    expectedIssuers: ["https://auth.example.com"],
    expectedAudiences: ["https://relay.example.com"],
    expectedError: "InvalidAudience",
    keyHex: undefined,
    verifierAlgorithmId: undefined,
  },
  {
    id: "invalid_tampered_signature",
    token:
      "ogEjEGNDQVQ.owF4GGh0dHBzOi8vYXV0aC5leGFtcGxlLmNvbQOBeBlodHRwczovL3JlbGF5LmV4YW1wbGUuY29tBBplVUKA.pF7GD7Gj-B0YtejX7fRwLlUmEkje-ME81oCc9oZaaYY",
    referenceTime: undefined,
    expectedIssuers: [],
    expectedAudiences: [],
    expectedError: "SignatureVerificationFailed",
    keyHex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    verifierAlgorithmId: undefined,
  },
  {
    id: "invalid_wrong_key",
    token:
      "ogEjEGNDQVQ.ogF4GGh0dHBzOi8vYXV0aC5leGFtcGxlLmNvbQQaZVVCgA.zmbxdkvbWtGtX0DExLC2nIxPDDmgAVImqk4rRSCCkCY",
    referenceTime: undefined,
    expectedIssuers: [],
    expectedAudiences: [],
    expectedError: "SignatureVerificationFailed",
    keyHex: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    verifierAlgorithmId: undefined,
  },
  {
    id: "invalid_algorithm_mismatch",
    token:
      "ogEjEGNDQVQ.ogF4GGh0dHBzOi8vYXV0aC5leGFtcGxlLmNvbQQaZVVCgA.zmbxdkvbWtGtX0DExLC2nIxPDDmgAVImqk4rRSCCkCY",
    referenceTime: undefined,
    expectedIssuers: [],
    expectedAudiences: [],
    expectedError: "AlgorithmMismatch",
    keyHex: undefined,
    verifierAlgorithmId: -7,
  },
];
