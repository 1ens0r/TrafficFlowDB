"""PostgreSQL connection pool + schema bootstrap.

Uses psycopg 3 with a small thread-safe pool. The ingest path is raw SQL
(prepared once per checkout) — no ORM overhead on the hot path.
"""
from __future__ import annotations

import os
import pathlib
import time
from urllib.parse import urlparse, urlunparse

import psycopg
from psycopg_pool import ConnectionPool

from .config import settings

_pool: ConnectionPool | None = None
_ro_pool: ConnectionPool | None = None

SCHEMA_FILES = ("schema.sql", "views.sql", "triggers.sql", "procedures.sql")
MIGRATION_FILES = ("migrate_india.sql", "migrate_all_india.sql",
                   "migrate_tomtom.sql", "migrate_more_corridors.sql",
                   "migrate_perf.sql", "migrate_probes.sql", "migrate_tomtom_traffic.sql")


def get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            settings.database_url,
            min_size=2,
            max_size=20,
            kwargs={"autocommit": True},
            open=True,
        )
    return _pool


def wait_for_db(timeout: float = 60.0) -> None:
    """Block until Postgres accepts connections (docker-compose bring-up)."""
    deadline = time.time() + timeout
    last: Exception | None = None
    while time.time() < deadline:
        try:
            with psycopg.connect(settings.database_url, autocommit=True) as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1")
            return
        except Exception as exc:  # noqa: BLE001 — retry on anything during boot
            last = exc
            time.sleep(1.0)
    raise RuntimeError(f"Database never became ready: {last}")


def init_db() -> None:
    """Create schema in dependency order, then run data migrations."""
    base = pathlib.Path(__file__).resolve().parent.parent / "database"
    pool = get_pool()
    with pool.connection() as conn:
        with conn.cursor() as cur:
            for name in SCHEMA_FILES:
                cur.execute((base / name).read_text())
        with conn.cursor() as cur:
            for name in MIGRATION_FILES:
                cur.execute((base / name).read_text())
    ensure_readonly_role()


RO_USER = os.environ.get("READONLY_DB_USER", "traffic_ro")
RO_PASSWORD = os.environ.get("READONLY_DB_PASSWORD", "trafficro")


def readonly_url() -> str:
    override = os.environ.get("READONLY_DATABASE_URL")
    if override:
        return override
    parts = urlparse(settings.database_url)
    netloc = f"{RO_USER}:{RO_PASSWORD}@{parts.hostname or 'localhost'}"
    if parts.port:
        netloc += f":{parts.port}"
    return urlunparse((parts.scheme, netloc, parts.path, "", "", ""))


def ensure_readonly_role() -> None:
    """Provision the SELECT-only role that powers the SQL Lab.

    Runs as the app owner; failures degrade gracefully (SQL Lab 503s)
    instead of taking the API down.
    """
    import re

    def _lit(value: str) -> str:
        # DDL (ALTER ROLE … PASSWORD) takes no bind params — embed a literal.
        # Password is operator-supplied env, still strictly validated + escaped.
        if not re.fullmatch(r"[A-Za-z0-9_@.\-]{1,128}", value):
            raise ValueError("READONLY_DB_PASSWORD has unsafe characters")
        return "'" + value.replace("'", "''") + "'"

    try:
        with get_pool().connection() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM pg_roles WHERE rolname = %s", (RO_USER,))
                if cur.fetchone() is None:
                    cur.execute(f'CREATE ROLE "{RO_USER}" WITH LOGIN')
                cur.execute(
                    f'ALTER ROLE "{RO_USER}" WITH PASSWORD {_lit(RO_PASSWORD)}')
                cur.execute(f'GRANT CONNECT ON DATABASE trafficflowdb TO "{RO_USER}"')
                cur.execute(f'GRANT USAGE ON SCHEMA public TO "{RO_USER}"')
                cur.execute(
                    f'GRANT SELECT ON ALL TABLES IN SCHEMA public TO "{RO_USER}"')
                cur.execute(
                    'ALTER DEFAULT PRIVILEGES FOR ROLE traffic IN SCHEMA public '
                    f'GRANT SELECT ON TABLES TO "{RO_USER}"')
    except Exception as exc:  # noqa: BLE001 — SQL Lab degrades, API stays up
        from . import querylog
        querylog.log("ERROR", "ensure_readonly_role failed", 0, str(exc)[:160])


def get_ro_pool() -> ConnectionPool:
    global _ro_pool
    if _ro_pool is None:
        _ro_pool = ConnectionPool(
            readonly_url(),
            min_size=1,
            max_size=5,
            kwargs={"autocommit": True, "options": "-c statement_timeout=5000"},
            open=True,
        )
    return _ro_pool


def close_pool() -> None:
    global _pool, _ro_pool
    if _pool is not None:
        _pool.close()
        _pool = None
    if _ro_pool is not None:
        _ro_pool.close()
        _ro_pool = None
