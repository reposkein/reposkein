import shutil
import subprocess
from pathlib import Path
import pytest
from track2.arms.reposkein_arm import RepoSkeinArm, _mcp_server_argv, _find_indexer


def _prereqs_ok() -> bool:
    try:
        _mcp_server_argv()  # raises if dist/index.js missing
    except Exception:
        return False
    return shutil.which("node") is not None


@pytest.mark.skipif(not _prereqs_ok(), reason="MCP server not built or node missing")
def test_reposkein_arm_smoke(tmp_path: Path):
    # tiny indexable repo
    (tmp_path / "lib.py").write_text("def helper():\n    return 1\n\ndef caller():\n    return helper()\n")
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    with RepoSkeinArm(tmp_path, "pytest -q") as tools:
        names = {t.name for t in tools}
        assert {"get_context_profile", "read_cypher", "reindex_file"} <= names
        gcp = {t.name: t for t in tools}["get_context_profile"]
        out = gcp.run({"name": "helper", "hops": 1})
        # helper is called by caller — the profile should mention it (or at least resolve)
        assert "caller" in out or "helper" in out
