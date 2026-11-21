import asyncio
import time
import uuid
from dataclasses import dataclass


@dataclass
class Lease:
    ws_key: str
    tab_id: str
    client_id: str
    label: str
    busy: bool
    epoch: int
    acquired_at: float
    updated_at: float
    expires_at: float


@dataclass
class _Handoff:
    handoff_id: str
    old_tab_id: str
    event: asyncio.Event
    acked: bool = False


class LeaseManager:
    """In-memory single-process workspace lease coordinator (single asyncio loop)."""

    def __init__(self, ttl_sec: float = 30.0, handoff_timeout_sec: float = 5.0):
        self.ttl_sec = float(ttl_sec)
        self.handoff_timeout_sec = float(handoff_timeout_sec)
        self._leases: dict[str, Lease] = {}
        self._last_epoch: dict[str, int] = {}
        self._streams: dict[tuple[str, str], asyncio.Queue] = {}
        self._handoffs: dict[str, _Handoff] = {}

    def _connected(self, lease: Lease) -> bool:
        return (lease.ws_key, lease.tab_id) in self._streams

    def _live(self, lease: Lease, now: float) -> bool:
        return self._connected(lease) or lease.expires_at > now

    def _serialize(self, lease: Lease, now: float) -> dict:
        return {
            "wsKey": lease.ws_key,
            "tabId": lease.tab_id,
            "clientId": lease.client_id,
            "label": lease.label,
            "busy": lease.busy,
            "epoch": lease.epoch,
            "acquiredAt": int(lease.acquired_at * 1000),
            "updatedAt": int(lease.updated_at * 1000),
            "ageMs": max(0, int((now - lease.updated_at) * 1000)),
            "connected": self._connected(lease),
        }

    def _next_epoch(self, ws_key: str, cur: Lease | None = None) -> int:
        prev = self._last_epoch.get(ws_key, 0)
        if cur is not None and cur.epoch > prev:
            prev = cur.epoch
        nxt = prev + 1
        self._last_epoch[ws_key] = nxt
        return nxt

    def _enqueue_revoke(self, q: asyncio.Queue, payload: dict) -> None:
        item = ("revoke", payload)
        if q.full():
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        q.put_nowait(item)

    async def acquire(
        self,
        ws_key: str,
        tab_id: str,
        client_id: str,
        label: str,
        busy: bool = False,
        force: bool = False,
        abort_busy: bool = False,
    ) -> tuple[int, dict]:
        now = time.time()
        cur = self._leases.get(ws_key)
        if cur is not None and not self._live(cur, now):
            del self._leases[ws_key]
            cur = None

        # 1. Free or same tab: grant / renew keeping epoch
        if cur is None:
            epoch = self._next_epoch(ws_key)
            lease = Lease(
                ws_key=ws_key,
                tab_id=tab_id,
                client_id=client_id,
                label=label,
                busy=bool(busy),
                epoch=epoch,
                acquired_at=now,
                updated_at=now,
                expires_at=now + self.ttl_sec,
            )
            self._leases[ws_key] = lease
            return 200, {"granted": True, "lease": self._serialize(lease, now)}

        if cur.tab_id == tab_id:
            cur.client_id = client_id
            cur.label = label
            cur.busy = bool(busy)
            cur.updated_at = now
            cur.expires_at = now + self.ttl_sec
            return 200, {"granted": True, "lease": self._serialize(cur, now)}

        # 2. Stale incarnation of this browser (reload/crash with lost beacon)
        if (
            cur.client_id == client_id
            and not self._connected(cur)
            and (now - cur.updated_at) > 2.0
        ):
            if ws_key in self._handoffs:
                return 409, {
                    "granted": False,
                    "handoffInProgress": True,
                    "holder": self._serialize(cur, now),
                }
            old = cur
            epoch = self._next_epoch(ws_key, old)
            new_lease = Lease(
                ws_key=ws_key,
                tab_id=tab_id,
                client_id=client_id,
                label=label,
                busy=bool(busy),
                epoch=epoch,
                acquired_at=now,
                updated_at=now,
                expires_at=now + self.ttl_sec,
            )
            self._leases[ws_key] = new_lease
            return 200, {
                "granted": True,
                "lease": self._serialize(new_lease, now),
                "displacedTabId": old.tab_id,
                "handedOffCleanly": False,
            }

        # 3. Held by another tab, not forcing
        if not force:
            return 409, {
                "granted": False,
                "busyConflict": False,
                "holder": self._serialize(cur, now),
            }

        # 4. Forcing while holder is busy without abort_busy
        if cur.busy and not abort_busy:
            return 409, {
                "granted": False,
                "busyConflict": True,
                "holder": self._serialize(cur, now),
            }

        # 5. Forcing transfer: transfer immediately before waiting on ack
        if ws_key in self._handoffs:
            return 409, {
                "granted": False,
                "handoffInProgress": True,
                "holder": self._serialize(cur, now),
            }

        old = cur
        epoch = self._next_epoch(ws_key, old)
        new_lease = Lease(
            ws_key=ws_key,
            tab_id=tab_id,
            client_id=client_id,
            label=label,
            busy=bool(busy),
            epoch=epoch,
            acquired_at=now,
            updated_at=now,
            expires_at=now + self.ttl_sec,
        )
        self._leases[ws_key] = new_lease

        old_q = self._streams.get((ws_key, old.tab_id))
        handed_off_cleanly = False
        if old_q is not None:
            handoff_id = uuid.uuid4().hex
            handoff = _Handoff(
                handoff_id=handoff_id,
                old_tab_id=old.tab_id,
                event=asyncio.Event(),
            )
            self._handoffs[ws_key] = handoff
            self._enqueue_revoke(
                old_q,
                {
                    "handoffId": handoff_id,
                    "newLabel": label,
                    "abortBusy": bool(abort_busy),
                },
            )
            try:
                await asyncio.wait_for(handoff.event.wait(), timeout=self.handoff_timeout_sec)
                handed_off_cleanly = handoff.acked
            except asyncio.TimeoutError:
                handed_off_cleanly = False
            finally:
                if self._handoffs.get(ws_key) is handoff:
                    self._handoffs.pop(ws_key, None)

        after = time.time()
        if self._leases.get(ws_key) is new_lease:
            new_lease.expires_at = max(new_lease.expires_at, after + self.ttl_sec)

        return 200, {
            "granted": True,
            "lease": self._serialize(new_lease, after),
            "displacedTabId": old.tab_id,
            "handedOffCleanly": handed_off_cleanly,
        }

    def ack(self, ws_key: str, tab_id: str, handoff_id: str) -> bool:
        handoff = self._handoffs.get(ws_key)
        if handoff is None:
            return False
        if handoff.handoff_id != handoff_id or handoff.old_tab_id != tab_id:
            return False
        handoff.acked = True
        handoff.event.set()
        return True

    def release(self, ws_key: str, tab_id: str) -> bool:
        released = False
        cur = self._leases.get(ws_key)
        if cur is not None and cur.tab_id == tab_id:
            del self._leases[ws_key]
            released = True
        handoff = self._handoffs.get(ws_key)
        if handoff is not None and handoff.old_tab_id == tab_id:
            handoff.acked = True
            handoff.event.set()
        return released

    def inspect(self, ws_key: str) -> dict | None:
        now = time.time()
        cur = self._leases.get(ws_key)
        if cur is None:
            return None
        if not self._live(cur, now):
            del self._leases[ws_key]
            return None
        return self._serialize(cur, now)

    def open_stream(self, ws_key: str, tab_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=8)
        self._streams[(ws_key, tab_id)] = q
        # If an evicted writer reconnects its SSE stream, notify it immediately.
        now = time.time()
        cur = self._leases.get(ws_key)
        if cur is not None and self._live(cur, now) and cur.tab_id != tab_id:
            self._enqueue_revoke(
                q,
                {
                    "handoffId": None,
                    "newLabel": cur.label,
                    "abortBusy": False,
                },
            )
        return q

    def close_stream(self, ws_key: str, tab_id: str, q: asyncio.Queue) -> None:
        key = (ws_key, tab_id)
        if self._streams.get(key) is not q:
            return
        del self._streams[key]
        now = time.time()
        cur = self._leases.get(ws_key)
        if cur is not None and cur.tab_id == tab_id:
            cur.expires_at = now + self.ttl_sec
        handoff = self._handoffs.get(ws_key)
        if handoff is not None and handoff.old_tab_id == tab_id:
            handoff.event.set()