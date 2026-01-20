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

#### データベース作成

```bash
curl -X POST http://localhost:8080/v1/organizations/myorg/databases \
  -H "Content-Type: application/json" \
  -d '{"name": "mydb", "group": "default"}'
```

レスポンス:
```json
{
  "database": {
    "DbId": "mock-mydb-1234567890",
    "HostName": "mydb.localhost:8080",
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
    { "Name": "mydb", "DbId": "mock-mydb", "HostName": "mydb.localhost:8080" }
  ]
}
```

> **Note**: `:org` パラメータは任意の値を指定できます（モックのため無視されます）

## ライセンス

MIT
