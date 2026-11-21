import os
import sqlite3
import threading
import time
import uuid


class StateStore:
    """Revisioned key/value persistence backed by a single SQLite database."""

    def __init__(self, data_dir: str):
        self.data_dir = os.path.abspath(os.path.expanduser(data_dir))
        os.makedirs(self.data_dir, exist_ok=True)
        self.db_path = os.path.join(self.data_dir, "workbench_state.sqlite3")
        self.server_id = self._load_or_create_server_id()
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._init_db()

    def _load_or_create_server_id(self) -> str:
        sid_path = os.path.join(self.data_dir, "server_id")
        if os.path.exists(sid_path):
            with open(sid_path, "r", encoding="utf-8") as f:
                existing = f.read().strip()
            if existing:
                return existing
        sid = str(uuid.uuid4())
        with open(sid_path, "w", encoding="utf-8") as f:
            f.write(sid + "\n")
        return sid

    def _init_db(self) -> None:
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL;")
            self._conn.execute("PRAGMA synchronous=NORMAL;")
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS kv (
                    store      TEXT    NOT NULL,
                    key        TEXT    NOT NULL,
                    rev        INTEGER NOT NULL,
                    deleted    INTEGER NOT NULL DEFAULT 0,
                    updated_at REAL    NOT NULL,
                    client_id  TEXT,
                    size       INTEGER NOT NULL DEFAULT 0,
                    value      BLOB,
                    PRIMARY KEY (store, key)
                );
                """
            )
            ver = self._conn.execute("PRAGMA user_version;").fetchone()[0]
            if ver == 0:
                self._conn.execute("PRAGMA user_version = 1;")
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def list(self, store: str, prefix: str = "") -> list[dict]:
        with self._lock:
            if prefix:
                rows = self._conn.execute(
                    """
                    SELECT key, rev, deleted, updated_at, size
                    FROM kv
                    WHERE store = ? AND substr(key, 1, ?) = ?
                    ORDER BY key ASC
                    """,
                    (store, len(prefix), prefix),
                ).fetchall()
            else:
                rows = self._conn.execute(
                    """
                    SELECT key, rev, deleted, updated_at, size
                    FROM kv
                    WHERE store = ?
                    ORDER BY key ASC
                    """,
                    (store,),
                ).fetchall()
        return [
            {
                "key": r[0],
                "rev": r[1],
                "deleted": bool(r[2]),
                "updatedAt": r[3],
                "size": r[4],
            }
            for r in rows
        ]

    def get(self, store: str, key: str) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                """
                SELECT rev, deleted, updated_at, value
                FROM kv
                WHERE store = ? AND key = ?
                """,
                (store, key),
            ).fetchone()
        if row is None:
            return None
        raw_val = bytes(row[3]) if row[3] is not None else None
        return {
            "rev": row[0],
            "deleted": bool(row[1]),
            "updatedAt": row[2],
            "value": raw_val,
        }

    def put(
        self,
        store: str,
        key: str,
        value: bytes,
        base_rev: int | None,
        client_id: str | None = None,
    ) -> tuple[bool, int]:
        if not isinstance(value, (bytes, bytearray, memoryview)):
            raise TypeError("value must be bytes-like")
        raw = bytes(value)
        now = time.time()
        with self._lock:
            with self._conn:
                row = self._conn.execute(
                    "SELECT rev FROM kv WHERE store = ? AND key = ?",
                    (store, key),
                ).fetchone()
                cur = row[0] if row is not None else 0
                if base_rev is not None and base_rev != cur:
                    return False, cur
                new_rev = cur + 1
                self._conn.execute(
                    """
                    INSERT INTO kv (store, key, rev, deleted, updated_at, client_id, size, value)
                    VALUES (?, ?, ?, 0, ?, ?, ?, ?)
                    ON CONFLICT(store, key) DO UPDATE SET
                        rev = excluded.rev,
                        deleted = 0,
                        updated_at = excluded.updated_at,
                        client_id = excluded.client_id,
                        size = excluded.size,
                        value = excluded.value
                    """,
                    (store, key, new_rev, now, client_id, len(raw), raw),
                )
                return True, new_rev

    def delete(
        self,
        store: str,
        key: str,
        base_rev: int | None,
        client_id: str | None = None,
    ) -> tuple[bool, int]:
        now = time.time()
        with self._lock:
            with self._conn:
                row = self._conn.execute(
                    "SELECT rev FROM kv WHERE store = ? AND key = ?",
                    (store, key),
                ).fetchone()
                cur = row[0] if row is not None else 0
                if base_rev is not None and base_rev != cur:
                    return False, cur
                new_rev = cur + 1
                self._conn.execute(
                    """
                    INSERT INTO kv (store, key, rev, deleted, updated_at, client_id, size, value)
                    VALUES (?, ?, ?, 1, ?, ?, 0, NULL)
                    ON CONFLICT(store, key) DO UPDATE SET
                        rev = excluded.rev,
                        deleted = 1,
                        updated_at = excluded.updated_at,
                        client_id = excluded.client_id,
                        size = 0,
                        value = NULL
                    """,
                    (store, key, new_rev, now, client_id),
                )
                return True, new_rev

    def delete_prefix(
        self,
        store: str,
        prefix: str,
        client_id: str | None = None,
    ) -> int:
        now = time.time()
        with self._lock:
            with self._conn:
                if prefix:
                    cur = self._conn.execute(
                        """
                        UPDATE kv
                        SET deleted = 1,
                            value = NULL,
                            size = 0,
                            rev = rev + 1,
                            updated_at = ?,
                            client_id = ?
                        WHERE store = ? AND deleted = 0 AND substr(key, 1, ?) = ?
                        """,
                        (now, client_id, store, len(prefix), prefix),
                    )
                else:
                    cur = self._conn.execute(
                        """
                        UPDATE kv
                        SET deleted = 1,
                            value = NULL,
                            size = 0,
                            rev = rev + 1,
                            updated_at = ?,
                            client_id = ?
                        WHERE store = ? AND deleted = 0
                        """,
                        (now, client_id, store),
                    )
                return cur.rowcount