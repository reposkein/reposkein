"""Arm A — RepoSkein. Indexes the checkout (zero-infra JSONL mode), spawns the
built @reposkein/mcp stdio server, and exposes its navigation tools to the loop
alongside the common tools. Uses a private event loop to bridge the async MCP
client into the synchronous Tool.run() contract."""
from __future__ import annotations
import asyncio
import json
import os
import subprocess
import threading
from pathlib import Path
from typing import Any
from ..tools.base import FuncTool, Tool
from ..tools.common import common_tools


def _find_indexer() -> str:
    """reposkein-indexer binary: env override > built cargo target > PATH."""
    env = os.environ.get("REPOSKEIN_INDEXER_BIN")
    if env and Path(env).exists():
        return env
    for cand in ["target/release/reposkein-indexer", "indexer/target/release/reposkein-indexer"]:
        p = (Path(__file__).resolve().parents[5] / cand)  # repo root from track2/arms/
        if p.exists():
            return str(p)
    return "reposkein-indexer"  # rely on PATH


def _mcp_server_argv() -> list[str]:
    """node <repo>/mcp/dist/index.js — the built MCP server entrypoint."""
    repo_root = Path(__file__).resolve().parents[5]
    server = repo_root / "mcp" / "dist" / "index.js"
    if not server.exists():
        raise RuntimeError(f"MCP server not built at {server}; run `npm run build` in mcp/")
    return ["node", str(server)]


def index_checkout(workdir: Path) -> None:
    """Write <workdir>/.reposkein/nodes.jsonl via the native indexer."""
    subprocess.run(
        [_find_indexer(), "index", str(workdir)], check=True, capture_output=True, text=True
    )


class _McpBridge:
    """Runs an asyncio MCP ClientSession on a dedicated background thread and
    exposes a synchronous call_tool(). Keeps the stdio server alive for the run."""

    def __init__(self, workdir: Path):
        self._workdir = workdir
        self._loop = asyncio.new_event_loop()
        self._ready = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._call = None  # set on the loop thread

    def _run(self):
        asyncio.set_event_loop(self._loop)
        self._loop.run_until_complete(self._serve())

    async def _serve(self):
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        env = {**os.environ, "REPOSKEIN_REPO_PATH": str(self._workdir), "REPOSKEIN_STORE": "jsonl"}
        argv = _mcp_server_argv()
        params = StdioServerParameters(command=argv[0], args=argv[1:], env=env)
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()

                async def call(name: str, args: dict) -> str:
                    res = await session.call_tool(name, args)
                    parts = [c.text for c in res.content if getattr(c, "type", None) == "text"]
                    return "\n".join(parts) if parts else json.dumps([c.__dict__ for c in res.content])

                self._call = call
                self._ready.set()
                await asyncio.Event().wait()  # keep session open until process exits

    def start(self):
        self._thread.start()
        if not self._ready.wait(timeout=60):
            raise RuntimeError("MCP server did not become ready within 60s")

    def call_tool(self, name: str, args: dict) -> str:
        fut = asyncio.run_coroutine_threadsafe(self._call(name, args), self._loop)
        return fut.result(timeout=120)


_RS_TOOL_SPECS: dict[str, dict[str, Any]] = {
    "get_context_profile": {
        "description": "Resolve a function/class (by node_id, file_path+name, or name) and return its caller/callee neighborhood with inlined prose. Use this FIRST to understand impact before editing.",
        "input_schema": {
            "type": "object",
            "properties": {
                "node_id": {"type": "string"},
                "file_path": {"type": "string"},
                "name": {"type": "string"},
                "hops": {"type": "integer", "enum": [1, 2]},
            },
        },
    },
    "read_cypher": {
        "description": "Run a read-only Cypher query against the RepoSkein code graph (callers/callees, file membership). Filter by n.repo_id.",
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}, "params": {"type": "object"}},
            "required": ["query"],
        },
    },
    "reindex_file": {
        "description": "Refresh the code graph after editing a source file. Pass its path.",
        "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
    },
}


def build_reposkein_tools(workdir: Path, test_cmd: str, bridge: _McpBridge) -> list[Tool]:
    rs_tools: list[Tool] = []
    for name, spec in _RS_TOOL_SPECS.items():
        rs_tools.append(
            FuncTool(
                name,
                spec["description"],
                spec["input_schema"],
                (lambda n: (lambda a: bridge.call_tool(n, a)))(name),
            )
        )
    return [*rs_tools, *common_tools(workdir, test_cmd)]


class RepoSkeinArm:
    """Lifecycle owner for arm A: index → start MCP bridge → expose tools."""

    def __init__(self, workdir: Path, test_cmd: str):
        self.workdir, self.test_cmd = workdir, test_cmd
        self._bridge: _McpBridge | None = None

    def __enter__(self) -> list[Tool]:
        index_checkout(self.workdir)
        self._bridge = _McpBridge(self.workdir)
        self._bridge.start()
        return build_reposkein_tools(self.workdir, self.test_cmd, self._bridge)

    def __exit__(self, *exc):
        # daemon thread + child process are torn down with the process; nothing to do
        return False
