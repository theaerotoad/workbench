import asyncio
import gzip
import io
import json
import zlib
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Route

ALLOWED_STORES = ("sessions", "baselines", "catalog", "settings", "vws")
_ALLOWED_STORE_SET = set(ALLOWED_STORES)
_MAX_KEY_LEN = 1024
_MAX_ID_LEN = 128
_MAX_LABEL_LEN = 80
_GZIP_RESPONSE_MIN_BYTES = 1024


def _parse_base_rev(request: Request) -> tuple[int | None, JSONResponse | None]:
    raw = request.headers.get("x-base-rev")
    if raw is None or raw.strip() == "":
        return None, None
    try:
        val = int(raw.strip())
    except ValueError:
        return None, JSONResponse({"error": "invalid X-Base-Rev header"}, status_code=400)
    if val < 0:
        return None, JSONResponse({"error": "X-Base-Rev must be non-negative"}, status_code=400)
    return val, None


def _decompress_gzip_bounded(data: bytes, max_bytes: int) -> bytes:
    with gzip.GzipFile(fileobj=io.BytesIO(data), mode="rb") as gz:
        return gz.read(max_bytes + 1)


def _accepts_gzip(request: Request) -> bool:
    raw = request.headers.get("accept-encoding", "")
    if not raw:
        return False
    for part in raw.split(","):
        token = part.split(";", 1)[0].strip().lower()
        if token == "gzip":
            return True
    return False


def make_state_routes(
    store,
    *,
    lease_manager=None,
    sync_secrets: bool = False,
    max_record_bytes: int = 64 * 1024 * 1024,
) -> list[Route]:
    def _check_store(store_name: str) -> JSONResponse | None:
        if store is None:
            return JSONResponse({"error": "persistence disabled"}, status_code=503)
        if store_name not in _ALLOWED_STORE_SET:
            return JSONResponse({"error": "unknown store"}, status_code=404)
        return None

    def _check_key(key: str) -> JSONResponse | None:
        if not isinstance(key, str) or not key or len(key) > _MAX_KEY_LEN:
            return JSONResponse({"error": "invalid key"}, status_code=400)
        return None

    def _check_id(val, field_name: str) -> JSONResponse | None:
        if not isinstance(val, str) or not val or len(val) > _MAX_ID_LEN:
            return JSONResponse({"error": f"invalid {field_name}"}, status_code=400)
        return None

    def _check_leases() -> JSONResponse | None:
        if lease_manager is None:
            return JSONResponse({"error": "persistence disabled"}, status_code=503)
        return None

    async def _parse_json_dict(request: Request) -> tuple[dict | None, JSONResponse | None]:
        raw = await request.body()
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None, JSONResponse({"error": "invalid json body"}, status_code=400)
        if not isinstance(parsed, dict):
            return None, JSONResponse({"error": "json body must be an object"}, status_code=400)
        return parsed, None

    async def capabilities(request: Request):
        enabled = store is not None
        leases_enabled = lease_manager is not None
        return JSONResponse(
            {
                "apiVersion": 1,
                "persistence": enabled,
                "serverId": store.server_id if enabled else None,
                "syncSecrets": bool(sync_secrets) if enabled else False,
                "maxRecordBytes": max_record_bytes,
                "stores": list(ALLOWED_STORES),
                "leases": leases_enabled,
                "leaseTtlMs": int(lease_manager.ttl_sec * 1000) if leases_enabled else 30000,
                "leaseHeartbeatMs": 10000,
                "leasePollMs": 5000,
            }
        )

    async def leases_endpoint(request: Request):
        err = _check_leases()
        if err is not None:
            return err

        if request.method == "GET":
            ws_key = request.query_params.get("wsKey", "")
            key_err = _check_key(ws_key)
            if key_err is not None:
                return key_err
            return JSONResponse({"holder": lease_manager.inspect(ws_key)})

        # POST /api/v1/leases
        data, body_err = await _parse_json_dict(request)
        if body_err is not None:
            return body_err

        ws_key = data.get("wsKey")
        tab_id = data.get("tabId")
        client_id = data.get("clientId")
        raw_label = data.get("label", "")

        for check in (
            _check_key(ws_key),
            _check_id(tab_id, "tabId"),
            _check_id(client_id, "clientId"),
        ):
            if check is not None:
                return check

        if raw_label is None:
            label = ""
        elif isinstance(raw_label, str):
            label = raw_label[:_MAX_LABEL_LEN]
        else:
            return JSONResponse({"error": "invalid label"}, status_code=400)

        busy = bool(data.get("busy", False))
        force = bool(data.get("force", False))
        abort_busy = bool(data.get("abortBusy", False))

        status_code, body = await lease_manager.acquire(
            ws_key,
            tab_id,
            client_id,
            label,
            busy=busy,
            force=force,
            abort_busy=abort_busy,
        )
        return JSONResponse(body, status_code=status_code)

    async def leases_ack(request: Request):
        err = _check_leases()
        if err is not None:
            return err
        data, body_err = await _parse_json_dict(request)
        if body_err is not None:
            return body_err

        ws_key = data.get("wsKey")
        tab_id = data.get("tabId")
        handoff_id = data.get("handoffId")
        for check in (
            _check_key(ws_key),
            _check_id(tab_id, "tabId"),
            _check_id(handoff_id, "handoffId"),
        ):
            if check is not None:
                return check

        clean = data.get("clean", True)
        if not isinstance(clean, bool):
            return JSONResponse({"error": "invalid clean"}, status_code=400)

        ok = lease_manager.ack(ws_key, tab_id, handoff_id, clean=clean)
        return JSONResponse({"ok": ok})

    async def leases_release(request: Request):
        err = _check_leases()
        if err is not None:
            return err
        data, body_err = await _parse_json_dict(request)
        if body_err is not None:
            return body_err

        ws_key = data.get("wsKey")
        tab_id = data.get("tabId")
        for check in (
            _check_key(ws_key),
            _check_id(tab_id, "tabId"),
        ):
            if check is not None:
                return check

        released = lease_manager.release(ws_key, tab_id)
        return JSONResponse({"released": released})

    async def leases_events(request: Request):
        err = _check_leases()
        if err is not None:
            return err
        ws_key = request.query_params.get("wsKey", "")
        tab_id = request.query_params.get("tabId", "")
        for check in (
            _check_key(ws_key),
            _check_id(tab_id, "tabId"),
        ):
            if check is not None:
                return check

        async def event_generator():
            q = lease_manager.open_stream(ws_key, tab_id)
            try:
                yield "retry: 3000\n: connected\n\n"
                while not await request.is_disconnected():
                    try:
                        event_name, payload = await asyncio.wait_for(q.get(), timeout=15.0)
                    except asyncio.TimeoutError:
                        if await request.is_disconnected():
                            break
                        yield ": ping\n\n"
                        continue
                    yield f"event: {event_name}\ndata: {json.dumps(payload)}\n\n"
            except asyncio.CancelledError:
                return
            finally:
                lease_manager.close_stream(ws_key, tab_id, q)

        return StreamingResponse(
            event_generator(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    async def kv_store_collection(request: Request):
        store_name = request.path_params["store"]
        err = _check_store(store_name)
        if err is not None:
            return err

        prefix = request.query_params.get("prefix", "")
        if request.method == "GET":
            items = await run_in_threadpool(store.list, store_name, prefix)
            return JSONResponse({"items": items})

        # DELETE /api/v1/kv/{store}?prefix=P
        if not prefix:
            return JSONResponse({"error": "non-empty prefix is required"}, status_code=400)
        client_id = request.headers.get("x-client-id")
        deleted = await run_in_threadpool(store.delete_prefix, store_name, prefix, client_id)
        return JSONResponse({"deleted": deleted})

    async def kv_item(request: Request):
        store_name = request.path_params["store"]
        err = _check_store(store_name)
        if err is not None:
            return err

        key = request.path_params["key"]
        key_err = _check_key(key)
        if key_err is not None:
            return key_err

        if request.method == "GET":
            rec = await run_in_threadpool(store.get, store_name, key)
            if rec is None:
                return JSONResponse({"error": "not found"}, status_code=404)
            rev_header = {"X-Rev": str(rec["rev"])}
            if rec["deleted"]:
                return JSONResponse(
                    {"error": "deleted", "rev": rec["rev"]},
                    status_code=410,
                    headers=rev_header,
                )
            body = rec["value"] if rec["value"] is not None else b""
            headers = dict(rev_header)
            if _accepts_gzip(request) and len(body) > _GZIP_RESPONSE_MIN_BYTES:
                body = await run_in_threadpool(gzip.compress, body)
                headers["Content-Encoding"] = "gzip"
                headers["Vary"] = "Accept-Encoding"
            return Response(
                content=body,
                status_code=200,
                media_type="application/json",
                headers=headers,
            )

        base_rev, rev_err = _parse_base_rev(request)
        if rev_err is not None:
            return rev_err
        client_id = request.headers.get("x-client-id")

        if request.method == "PUT":
            raw_body = await request.body()
            content_encoding = request.headers.get("content-encoding", "").strip().lower()
            if content_encoding == "gzip":
                try:
                    raw_body = await run_in_threadpool(
                        _decompress_gzip_bounded, raw_body, max_record_bytes
                    )
                except (gzip.BadGzipFile, OSError, EOFError, zlib.error):
                    return JSONResponse({"error": "invalid gzip body"}, status_code=400)
            elif content_encoding and content_encoding != "identity":
                return JSONResponse(
                    {"error": f"unsupported Content-Encoding: {content_encoding}"},
                    status_code=415,
                )

            if len(raw_body) > max_record_bytes:
                return JSONResponse(
                    {"error": "record too large", "maxRecordBytes": max_record_bytes},
                    status_code=413,
                )

            ok, rev = await run_in_threadpool(
                store.put, store_name, key, raw_body, base_rev, client_id
            )
            if not ok:
                return JSONResponse(
                    {"rev": rev},
                    status_code=412,
                    headers={"X-Rev": str(rev)},
                )
            return JSONResponse(
                {"rev": rev},
                status_code=200,
                headers={"X-Rev": str(rev)},
            )

        # DELETE /api/v1/kv/{store}/{key}
        ok, rev = await run_in_threadpool(
            store.delete, store_name, key, base_rev, client_id
        )
        if not ok:
            return JSONResponse(
                {"rev": rev},
                status_code=412,
                headers={"X-Rev": str(rev)},
            )
        return JSONResponse(
            {"rev": rev},
            status_code=200,
            headers={"X-Rev": str(rev)},
        )

    return [
        Route("/api/v1/capabilities", capabilities, methods=["GET"]),
        Route("/api/v1/leases", leases_endpoint, methods=["GET", "POST"]),
        Route("/api/v1/leases/ack", leases_ack, methods=["POST"]),
        Route("/api/v1/leases/release", leases_release, methods=["POST"]),
        Route("/api/v1/leases/events", leases_events, methods=["GET"]),
        Route("/api/v1/kv/{store}", kv_store_collection, methods=["GET", "DELETE"]),
        Route("/api/v1/kv/{store}/{key:path}", kv_item, methods=["GET", "PUT", "DELETE"]),
    ]