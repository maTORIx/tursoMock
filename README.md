# tursomock

Turso データベースのモックサーバー。ローカル開発やテストで使用できます。

## 必要環境

- [Bun](https://bun.sh/) v1.0.0 以上

## インストール

```bash
bun add github:matorix/tursoMock
```

## 使い方

### サーバー起動

```bash
bunx tursomock serve
bunx tursomock serve --port 3000 --db-dir ./data
```

### テストでの利用

`--memory` を付けると DB をメモリ上だけに保持します。ディスクへ書き込まないのでテストが速くなり、停止するとデータは消えます。

```bash
tursomock serve --memory --port 8088
```

URL の先頭に `/ns/<namespace>` を付けると、名前空間ごとに DB が分かれます。並列に動くテストファイルが同じ DB 名を使っても互いに干渉しません。Management API と Hrana の両方で使えます。名前空間に使える文字は DB 名と同じです。

```text
POST http://localhost:8088/ns/file-a/v1/organizations/mock/databases
POST http://localhost:8088/ns/file-a/subject-1/v2/pipeline
```

### データベースリセット

```bash
bunx tursomock reset
bunx tursomock reset --force  # 確認なし
```

## libsql クライアントでの接続

```typescript
import { createClient } from "@libsql/client";

const client = createClient({
  url: "http://mydb.localhost:8080",
});

await client.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
await client.execute({ sql: "INSERT INTO users (name) VALUES (?)", args: ["Alice"] });
```

## 対応 API

### Hrana v2 Protocol

libsql クライアント用のエンドポイント。

- `POST /v2/pipeline` - サブドメインからDB名を取得 (`http://mydb.localhost:8080/v2/pipeline`)
- `POST /:dbName/v2/pipeline` - パスベースでDB名を指定

### Management API

Turso Platform API 互換のデータベース管理エンドポイント。

#### 認証

Management API (`/v1/*`) は `Authorization: Bearer <token>` を要求します。モックでは固定トークン `mock-platform-token` を受け付けます (`MOCK_PLATFORM_TOKEN` としてexport)。Hrana pipeline (libsql接続) は便宜上認証なしで通します。

#### データベース作成

```bash
curl -X POST http://localhost:8080/v1/organizations/myorg/databases \
  -H "Authorization: Bearer mock-platform-token" \
  -H "Content-Type: application/json" \
  -d '{"name": "mydb", "group": "default"}'
```

レスポンス:
```json
{
  "database": {
    "DbId": "mock-mydb-1234567890",
    "Hostname": "mydb.localhost:8080",
    "Name": "mydb"
  }
}
```

#### データベース削除

```bash
curl -X DELETE http://localhost:8080/v1/organizations/myorg/databases/mydb
```

#### データベース一覧

```bash
curl http://localhost:8080/v1/organizations/myorg/databases
```

レスポンス:
```json
{
  "databases": [
    { "Name": "mydb", "DbId": "mock-mydb", "Hostname": "mydb.localhost:8080" }
  ]
}
```

#### DB ファイルのアップロード

Turso の `seed: { type: "database_upload" }` と `POST /v1/upload` を再現します。

```bash
curl -X POST http://localhost:8080/v1/organizations/myorg/databases \
  -H "Authorization: Bearer mock-platform-token" \
  -d '{"name": "mydb", "group": "rag", "seed": {"type": "database_upload"}}'

curl -X POST http://mydb.localhost:8080/v1/upload \
  -H "Authorization: Bearer mock-db-jwt-token" \
  --data-binary @mydb.db
```

- アップロードできるのは `database_upload` で作った DB に 1 回だけ
- ファイルは WAL モード (ヘッダの 18・19 バイト目が 2) でなければ 400
- 名前空間の中では `/ns/<namespace>/v1/upload` (対象はその名前空間の DB)
- `--memory` では使えません (`database_upload` の DB を作る時点で 400)

#### グループトークン

```bash
curl -X POST "http://localhost:8080/v1/organizations/myorg/groups/rag/auth/tokens?authorization=read-only" \
  -H "Authorization: Bearer mock-platform-token"
```

- 固定値を返します: full-access は `mock-db-jwt-token`、read-only は `mock-db-jwt-read-only`
- read-only のトークンで送った pipeline は、読み取り専用 (`mode=ro`) で開いた別の接続で実行します。書き込みは文の形 (CTE・複文・`PRAGMA query_only = 0` など) にかかわらず SQLite が `SQLITE_READONLY` で拒否します (トークン無しは従来どおり素通し)
- `--memory` では read-only のトークンを受けません (pipeline が 400)。インメモリの DB は読み取り専用の接続を別に開けないので、守れているふりをせずに断ります

> **Note**: `:org` パラメータは任意の値を指定できます（モックのため無視されます）

## ライセンス

MIT
