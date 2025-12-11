"""LaTeX MCP server (Python) matching the Node version's behavior.

Tools:
1) build_latex: latexmk -synctex=1 -interaction=nonstopmode -file-line-error with engine flag.
2) clean_latex: latexmk -c / -C against the target .tex file.
3) read_latex_log: read the .log file next to the .tex entry point.

Transports:
- STDIO (enabled by default)
- Streamable HTTP on /mcp (enabled by default)

Environment:
- WORKSPACE_ROOT: absolute path that tool inputs must stay within (default: /workspaces).
- MCP_HOST / MCP_PORT: bind address and port for HTTP transport (defaults: 0.0.0.0 / 4000).
- ENABLE_STDIO / ENABLE_HTTP: set to "0" to disable either transport.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
from pathlib import Path
from typing import Literal

from mcp.server.fastmcp import FastMCP

# Match the Node implementation: enforce a workspace root and block paths outside it.
WORKSPACE_ROOT = Path(os.environ.get("WORKSPACE_ROOT", "/workspaces")).resolve()
MCP_HOST = os.environ.get("MCP_HOST", "0.0.0.0")
MCP_PORT = int(os.environ.get("MCP_PORT", "4000"))


def path_guidance() -> str:
    return initial_guidance()


def workspace_overview(max_entries: int = 10) -> str:
    """Return a short listing of WORKSPACE_ROOT and first-level subdirectories."""
    try:
        entries = [p for p in WORKSPACE_ROOT.iterdir()]
    except Exception as exc:  # pragma: no cover - defensive
        return f"(could not list {WORKSPACE_ROOT}: {exc})"

    lines = [f"- {WORKSPACE_ROOT}"]
    dirs = sorted([p for p in entries if p.is_dir()])

    for d in dirs[:max_entries]:
        try:
            subs = sorted([p.name for p in d.iterdir() if p.is_dir()])
        except Exception:
            subs = []
        suffix = f" (subdirs: {', '.join(subs[:5])})" if subs else ""
        lines.append(f"  - {d.name}{suffix}")

    if len(dirs) > max_entries:
        lines.append(f"  - ... ({len(dirs) - max_entries} more)")

    return "\n".join(lines)


def initial_guidance() -> str:
    """General instructions for clients/models about path handling and workspace shape."""
    overview = workspace_overview()
    return (
        f"This MCP server runs inside a dev container. Use paths under {WORKSPACE_ROOT} "
        "as seen inside the container; the server will reject paths outside this root. "
        "If you are on Windows, rewrite host paths like "
        "C:\\Users\\...\\<repo>\\subdir\\file.tex to /workspaces/<repo>/subdir/file.tex "
        "or a relative path under WORKSPACE_ROOT before calling the tools. "
        "The server does not auto-convert host paths. "
        f"Workspace overview:\n{overview}"
    )


def resolve_workspace_path(user_path: str) -> Path:
    """Resolve a user-supplied path, enforcing it lives inside WORKSPACE_ROOT."""
    candidate = Path(user_path)
    abs_path = candidate if candidate.is_absolute() else (WORKSPACE_ROOT / candidate)
    abs_path = abs_path.resolve()

    # Raise if the path escapes the allowed root.
    try:
        abs_path.relative_to(WORKSPACE_ROOT)
    except ValueError as exc:
        raise ValueError(
            f"Path {abs_path} is outside workspace root {WORKSPACE_ROOT}. {path_guidance()}"
        ) from exc

    return abs_path


def run_command(cmd: str, cwd: Path) -> str:
    """Run a shell command in cwd and return combined stdout/stderr, like the Node version."""
    result = subprocess.run(
        cmd,
        shell=True,
        cwd=str(cwd),
        text=True,
        capture_output=True,
    )

    log = f"> {cmd}\n\n"
    log += result.stdout or ""
    log += result.stderr or ""

    if result.returncode:
        log += f"\n\n[latex-mcp] Command exited with code {result.returncode}\n"

    return log


async def run_command_async(cmd: str, cwd: Path) -> str:
    """Async version of run_command without threads (avoids sandbox thread limits)."""
    proc = await asyncio.create_subprocess_shell(
        cmd,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()

    log = f"> {cmd}\n\n"
    log += stdout.decode() if stdout else ""
    log += stderr.decode() if stderr else ""

    if proc.returncode:
        log += f"\n\n[latex-mcp] Command exited with code {proc.returncode}\n"

    return log


mcp = FastMCP(
    name="latex-compiler",
    json_response=True,
    host=MCP_HOST,
    port=MCP_PORT,
    streamable_http_path="/mcp",
)

# Optional: serve OAuth metadata endpoints to silence discovery probes.
if hasattr(mcp, "app"):
    @mcp.app.get("/.well-known/oauth-authorization-server")
    async def oauth_meta_root() -> dict:
        return {}

    @mcp.app.get("/mcp/.well-known/oauth-authorization-server")
    async def oauth_meta_mcp() -> dict:
        return {}


@mcp.tool()
async def build_latex(
    file: str,
    engine: Literal["pdflatex", "xelatex", "lualatex"] = "pdflatex",
) -> str:
    """Build the given .tex file with latexmk.

    Path note: pass container paths under WORKSPACE_ROOT (e.g., /workspaces/<repo>/...). If you are on Windows,
    rewrite C:\\Users\\...\\<repo>\\foo.tex -> /workspaces/<repo>/foo.tex before calling.
    """
    try:
        abs_path = resolve_workspace_path(file)
    except ValueError as exc:
        return f"ERROR: {exc}"

    if not abs_path.exists():
        return f"ERROR: File not found: {abs_path}\n{path_guidance()}"

    cwd = abs_path.parent
    filename = abs_path.name

    engine_flag = "-pdf"
    if engine == "xelatex":
        engine_flag = "-pdfxe"
    elif engine == "lualatex":
        engine_flag = "-pdflua"

    cmd = " ".join(
        [
            "latexmk",
            "-synctex=1",
            "-interaction=nonstopmode",
            "-file-line-error",
            engine_flag,
            f'"{filename}"',
        ]
    )

    log = await run_command_async(cmd, cwd)

    base = abs_path.stem
    pdf_path = cwd / f"{base}.pdf"
    pdf_exists = pdf_path.exists()

    summary = (
        "build_latex finished.\n\n"
        f"Working directory: {cwd}\n"
        f"Command: {cmd}\n"
        f"PDF exists: {pdf_path if pdf_exists else 'NO'}\n\n"
        f"--- Latexmk log ---\n{log}"
    )

    return summary


@mcp.tool()
async def clean_latex(
    file: str,
    mode: Literal["aux", "all"] = "aux",
) -> str:
    """Clean latexmk artifacts next to the target .tex.

    Path note: pass container paths under WORKSPACE_ROOT (e.g., /workspaces/<repo>/...). If you are on Windows,
    rewrite C:\\Users\\...\\<repo>\\foo.tex -> /workspaces/<repo>/foo.tex before calling.
    """
    try:
        abs_path = resolve_workspace_path(file)
    except ValueError as exc:
        return f"ERROR: {exc}"

    if not abs_path.exists():
        return f"ERROR: File not found: {abs_path}\n{path_guidance()}"

    cwd = abs_path.parent
    filename = abs_path.name
    flag = "-C" if mode == "all" else "-c"

    cmd = f'latexmk {flag} "{filename}"'
    log = await run_command_async(cmd, cwd)

    msg = (
        "clean_latex finished.\n"
        f"Mode: {mode}\n"
        f"Command: {cmd}\n\n"
        f"--- Latexmk log ---\n{log}"
    )

    return msg


@mcp.tool()
def read_latex_log(file: str) -> str:
    """Read the .log file next to the target .tex.

    Path note: pass container paths under WORKSPACE_ROOT (e.g., /workspaces/<repo>/...). If you are on Windows,
    rewrite C:\\Users\\...\\<repo>\\foo.tex -> /workspaces/<repo>/foo.tex before calling.
    """
    try:
        abs_path = resolve_workspace_path(file)
    except ValueError as exc:
        return f"ERROR: {exc}"

    cwd = abs_path.parent
    base = abs_path.stem
    log_path = cwd / f"{base}.log"

    if not log_path.exists():
        return (
            f"Log file not found: {log_path}\nYou may need to run build_latex first.\n{path_guidance()}"
        )

    content = log_path.read_text(encoding="utf-8", errors="ignore")
    return f"Log path: {log_path}\n\n{content}"


async def main() -> None:
    enable_stdio = os.environ.get("ENABLE_STDIO", "1") != "0"
    enable_http = os.environ.get("ENABLE_HTTP", "1") != "0"

    tasks: list[asyncio.Task[None]] = []

    if enable_stdio:
        tasks.append(asyncio.create_task(mcp.run_stdio_async()))

    if enable_http:
        tasks.append(asyncio.create_task(mcp.run_streamable_http_async()))

    if not tasks:
        raise RuntimeError("No transports enabled; set ENABLE_STDIO or ENABLE_HTTP to 1.")

    await asyncio.gather(*tasks)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
