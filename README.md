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

- **Hrana v2 Protocol** (`/v2/pipeline`) - libsql クライアント用
- **Management API** - データベース作成・削除・一覧

## ライセンス

MIT
